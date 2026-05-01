import { createHash } from 'crypto';

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

// Extract a per-user / per-session signal from the request body so two
// different end users sharing one API key get different conversation pool
// scopes. v2.0.25 HIGH-3: chat & responses now look at body.user /
// conversation / previous_response_id / metadata.{conversation_id,session_id}.
//
// metadata.user_id is INTENTIONALLY NOT inspected here — handlers/messages.js
// has a specialized parser for it (Claude Code's JSON-encoded
// {device_id, session_id, account_uuid} shape) and appends its own
// `:user:<digest>` to keep the two extraction paths from double-stamping
// the same callerKey.
//
// The returned subkey is appended to the API-key callerKey so reuse stays
// pinned to (apiKey, user/session). Returns '' when no usable signal.
export function extractBodyCallerSubKey(body) {
  if (!body || typeof body !== 'object') return '';
  const candidates = [
    typeof body.user === 'string' ? body.user : '',
    typeof body?.metadata?.conversation_id === 'string' ? body.metadata.conversation_id : '',
    typeof body.conversation === 'string' ? body.conversation : '',
    typeof body.previous_response_id === 'string' ? body.previous_response_id : '',
    typeof body?.metadata?.session_id === 'string' ? body.metadata.session_id : '',
  ].filter(Boolean);
  if (!candidates.length) return '';
  return sha256Hex(candidates.join('|')).slice(0, 16);
}

// IP + UA fallback used when an apiKey-mode caller has no explicit body
// user signal. Without this, every Claude Code / claudecode CLI on a
// self-hosted single-user setup hits "shared API key, no per-user scope"
// and cascade reuse stays disabled — exactly the symptom reported in
// #93 follow-up by zhangzhang-bit (claude-opus-4-6-thinking, msgs growing
// 33→97 across turns, reuse=false on every Cascade started).
//
// Two physical clients sharing one apiKey will land on different IP/UA
// hashes and stay isolated; same client across turns lands on the same
// hash and lets the cascade pool reuse the upstream session.
function ipUaFingerprint(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  const ua = req?.headers?.['user-agent'] || '';
  if (!ip && !ua) return '';
  return sha256Hex(`${ip}\0${ua}`).slice(0, 16);
}

function headerValue(req, name) {
  const value = req?.headers?.[name] ?? req?.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').trim();
}

function requestIp(req) {
  const forwarded = headerValue(req, 'x-forwarded-for').split(',')[0].trim();
  const raw = forwarded || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  const ip = String(raw || '').trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
  return ip === '::1' ? '127.0.0.1' : ip;
}

function safeText(value, fallback = '', max = 120) {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  return text || fallback;
}

function maskedToken(apiKey) {
  const text = String(apiKey || '').trim();
  if (!text) return 'anonymous';
  if (text.length <= 10) return `${text.slice(0, 3)}...${text.slice(-2)}`;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function projectFromBody(body) {
  return body?.metadata?.project
    || body?.metadata?.project_id
    || body?.metadata?.client_project
    || body?.project
    || '';
}

function clientNameFromBody(body) {
  return body?.metadata?.client_name
    || body?.metadata?.client
    || body?.metadata?.app
    || '';
}

function deviceTagFromMetadata(body) {
  const userId = body?.metadata?.user_id;
  if (typeof userId !== 'string' || !userId) return '';
  try {
    const parsed = JSON.parse(userId);
    if (parsed && typeof parsed === 'object') {
      return parsed.device_id || parsed.deviceId || parsed.session_id || parsed.sessionId || parsed.account_uuid || parsed.accountUuid || '';
    }
  } catch {}
  return userId;
}

export function requestAttributionFromRequest(req, apiKey = '', body = null) {
  const ip = requestIp(req);
  const userAgent = headerValue(req, 'user-agent');
  const tokenHash = apiKey ? sha256Hex(apiKey).slice(0, 16) : '';
  const deviceTag = deviceTagFromMetadata(body);
  const ipua = ipUaFingerprint(req);
  const deviceHash = deviceTag ? sha256Hex(deviceTag).slice(0, 16) : ipua;
  const isLocal = !ip || ip === '127.0.0.1' || ip === 'localhost';
  const network = isLocal ? 'local' : 'lan';
  const clientName = headerValue(req, 'x-client-name') || headerValue(req, 'x-device-name') || clientNameFromBody(body);
  const project = headerValue(req, 'x-project')
    || headerValue(req, 'x-client-project')
    || headerValue(req, 'x-project-id')
    || projectFromBody(body);
  return {
    tokenId: tokenHash ? `api:${tokenHash}` : 'anonymous',
    tokenLabel: maskedToken(apiKey),
    deviceId: deviceHash ? `device:${deviceHash}` : 'unknown',
    deviceLabel: safeText(clientName, ip ? `${network}:${ip}` : network, 120),
    ip: safeText(ip, 'unknown', 80),
    userAgent: safeText(userAgent, '', 200),
    project: safeText(project, 'default', 80),
    network,
  };
}

export function callerKeyFromRequest(req, apiKey = '', body = null) {
  const bodySubKey = body ? extractBodyCallerSubKey(body) : '';
  if (apiKey) {
    const base = `api:${sha256Hex(apiKey).slice(0, 32)}`;
    if (bodySubKey) return `${base}:user:${bodySubKey}`;
    const ipua = ipUaFingerprint(req);
    return ipua ? `${base}:client:${ipua}` : base;
  }
  const sessionId = req?.headers?.['x-dashboard-session'] || req?.headers?.['x-session-id'] || '';
  if (sessionId) {
    const base = `session:${sha256Hex(sessionId).slice(0, 32)}`;
    return bodySubKey ? `${base}:user:${bodySubKey}` : base;
  }
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  const ua = req?.headers?.['user-agent'] || '';
  const base = `client:${sha256Hex(`${ip}\0${ua}`).slice(0, 32)}`;
  return bodySubKey ? `${base}:user:${bodySubKey}` : base;
}

// Returns true if we have any per-user signal beyond the bare API key.
// chat.js consults this to decide whether to allow conversation reuse for a
// shared API key with no user dimension — pre-v2.0.25 we did, which let two
// concurrent end users on the same proxy key share each other's cascade
// state. Now defaults to off; set CASCADE_REUSE_ALLOW_SHARED_API_KEY=1 to
// restore the legacy permissive behavior.
export function hasCallerScope(callerKey, req, body) {
  if (typeof callerKey === 'string') {
    if (callerKey.includes(':user:')) return true;
    // Match :client: anywhere — apiKey-mode now appends `:client:<ip+ua>`
    // as a fallback subkey when there's no body user signal, so the
    // scope check has to look past the prefix.
    if (callerKey.includes(':client:')) return true;
    if (callerKey.startsWith('session:') || callerKey.startsWith('client:')) return true;
  }
  if (body && extractBodyCallerSubKey(body)) return true;
  if (req?.headers?.['x-dashboard-session'] || req?.headers?.['x-session-id']) return true;
  return false;
}
