/**
 * Request statistics collector with debounced JSON persistence.
 */

import { readFileSync, existsSync } from 'fs';
import { writeJsonAtomic } from '../fs-atomic.js';
import { join } from 'path';
import { config } from '../config.js';

const STATS_FILE = join(config.dataDir, 'stats.json');
const STATS_PERSIST_DISABLED = process.execArgv.includes('--test')
  || process.env.WINDSURFAPI_DISABLE_STATS_PERSIST === '1';

const _state = {
  startedAt: Date.now(),
  totalRequests: 0,
  successCount: 0,
  errorCount: 0,
  modelCounts: {},    // { "gpt-4o-mini": { requests, success, errors, totalMs } }
  accountCounts: {},  // { "abc123": { requests, success, errors } }
  tokenCounts: {},
  deviceCounts: {},
  projectCounts: {},
  usageTotals: {},
  hourlyBuckets: [],  // [{ hour: "2026-04-09T07:00:00Z", requests, errors }]
};

// Load persisted stats
try {
  if (!STATS_PERSIST_DISABLED && existsSync(STATS_FILE)) {
    const saved = JSON.parse(readFileSync(STATS_FILE, 'utf-8'));
    Object.assign(_state, saved);
  }
} catch {}

// Debounced save
let _saveTimer = null;
function scheduleSave() {
  if (STATS_PERSIST_DISABLED) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      writeJsonAtomic(STATS_FILE, _state);
    } catch {}
  }, 5000);
}

function getHourKey() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

function emptyUsage() {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    localCachePromptTokens: 0,
    localCacheCompletionTokens: 0,
    localCacheRequests: 0,
    requestsWithUsage: 0,
  };
}

function ensureUsage(target) {
  if (!target.usage) target.usage = emptyUsage();
  for (const [k, v] of Object.entries(emptyUsage())) {
    if (!Number.isFinite(Number(target.usage[k]))) target.usage[k] = v;
  }
  return target.usage;
}

function ensureCounter(target) {
  if (!Number.isFinite(Number(target.requests))) target.requests = 0;
  if (!Number.isFinite(Number(target.success))) target.success = 0;
  if (!Number.isFinite(Number(target.errors))) target.errors = 0;
  if (!Number.isFinite(Number(target.totalMs))) target.totalMs = 0;
  if (!Array.isArray(target.recentMs)) target.recentMs = [];
  ensureUsage(target);
  return target;
}

function ensureStateShape() {
  if (!_state.modelCounts) _state.modelCounts = {};
  if (!_state.accountCounts) _state.accountCounts = {};
  if (!_state.tokenCounts) _state.tokenCounts = {};
  if (!_state.deviceCounts) _state.deviceCounts = {};
  if (!_state.projectCounts) _state.projectCounts = {};
  if (!_state.usageTotals) _state.usageTotals = emptyUsage();
  ensureUsage(_state);
}

ensureStateShape();

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function normalizeUsage(usage, meta = {}) {
  if (!usage || typeof usage !== 'object') return emptyUsage();
  const cacheCreation = usage.cache_creation || {};
  const cacheWrite5m = num(cacheCreation.ephemeral_5m_input_tokens);
  const cacheWrite1h = num(cacheCreation.ephemeral_1h_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens)
    || cacheWrite5m + cacheWrite1h;
  const cacheRead = num(usage.cache_read_input_tokens)
    || num(usage.prompt_tokens_details?.cached_tokens);
  const promptTokens = num(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = num(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = num(usage.total_tokens) || promptTokens + completionTokens;
  const localCache = !!meta.cached;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheWrite5mTokens: cacheWrite5m,
    cacheWrite1hTokens: cacheWrite1h,
    localCachePromptTokens: localCache ? promptTokens : 0,
    localCacheCompletionTokens: localCache ? completionTokens : 0,
    localCacheRequests: localCache ? 1 : 0,
    requestsWithUsage: totalTokens || promptTokens || completionTokens || cacheRead || cacheWrite ? 1 : 0,
  };
}

function addUsage(target, usage, meta = {}) {
  const dst = ensureUsage(target);
  const src = normalizeUsage(usage, meta);
  dst.promptTokens += src.promptTokens;
  dst.completionTokens += src.completionTokens;
  dst.totalTokens += src.totalTokens;
  dst.cacheReadTokens += src.cacheReadTokens;
  dst.cacheWriteTokens += src.cacheWriteTokens;
  dst.cacheWrite5mTokens += src.cacheWrite5mTokens;
  dst.cacheWrite1hTokens += src.cacheWrite1hTokens;
  dst.localCachePromptTokens += src.localCachePromptTokens;
  dst.localCacheCompletionTokens += src.localCacheCompletionTokens;
  dst.localCacheRequests += src.localCacheRequests;
  dst.requestsWithUsage += src.requestsWithUsage;
}

function addCounter(target, success, durationMs, usage, meta = {}) {
  ensureCounter(target);
  target.requests++;
  if (success) target.success++;
  else target.errors++;
  target.totalMs += durationMs;
  if (durationMs > 0) {
    target.recentMs.push(durationMs);
    if (target.recentMs.length > 200) target.recentMs.shift();
  }
  addUsage(target, usage, meta);
}

function safeLabel(value, fallback) {
  const text = String(value || '').trim().slice(0, 120);
  return text || fallback;
}

function callerMeta(caller) {
  return {
    tokenId: safeLabel(caller?.tokenId, 'anonymous'),
    tokenLabel: safeLabel(caller?.tokenLabel, 'anonymous'),
    deviceId: safeLabel(caller?.deviceId, 'unknown'),
    deviceLabel: safeLabel(caller?.deviceLabel, 'unknown'),
    ip: safeLabel(caller?.ip, 'unknown'),
    userAgent: safeLabel(caller?.userAgent, ''),
    project: safeLabel(caller?.project, 'default'),
  };
}

function setMeta(target, meta) {
  target.label = meta.label || target.label || '';
  target.lastSeen = Date.now();
  for (const [k, v] of Object.entries(meta)) {
    if (v != null && v !== '') target[k] = v;
  }
}

/**
 * Record a completed request.
 */
export function recordRequest(model, success, durationMs, accountId, details = {}) {
  ensureStateShape();
  _state.totalRequests++;
  if (success) _state.successCount++;
  else _state.errorCount++;
  addUsage(_state, details.usage, details);

  // Per-model stats (includes a small ring buffer for p50/p95 latency)
  if (!_state.modelCounts[model]) {
    _state.modelCounts[model] = { requests: 0, success: 0, errors: 0, totalMs: 0, recentMs: [] };
  }
  const mc = _state.modelCounts[model];
  addCounter(mc, success, durationMs, details.usage, details);

  // Per-account stats
  if (accountId) {
    const aid = typeof accountId === 'string' ? accountId.slice(0, 8) : String(accountId);
    if (!_state.accountCounts[aid]) {
      _state.accountCounts[aid] = { requests: 0, success: 0, errors: 0 };
    }
    const ac = _state.accountCounts[aid];
    addCounter(ac, success, durationMs, details.usage, details);
  }

  const meta = callerMeta(details.caller);
  if (!_state.tokenCounts[meta.tokenId]) _state.tokenCounts[meta.tokenId] = { requests: 0, success: 0, errors: 0, totalMs: 0, recentMs: [] };
  setMeta(_state.tokenCounts[meta.tokenId], { label: meta.tokenLabel, tokenLabel: meta.tokenLabel });
  addCounter(_state.tokenCounts[meta.tokenId], success, durationMs, details.usage, details);

  if (!_state.deviceCounts[meta.deviceId]) _state.deviceCounts[meta.deviceId] = { requests: 0, success: 0, errors: 0, totalMs: 0, recentMs: [] };
  setMeta(_state.deviceCounts[meta.deviceId], { label: meta.deviceLabel, deviceLabel: meta.deviceLabel, ip: meta.ip, userAgent: meta.userAgent });
  addCounter(_state.deviceCounts[meta.deviceId], success, durationMs, details.usage, details);

  if (!_state.projectCounts[meta.project]) _state.projectCounts[meta.project] = { requests: 0, success: 0, errors: 0, totalMs: 0, recentMs: [] };
  setMeta(_state.projectCounts[meta.project], { label: meta.project, project: meta.project });
  addCounter(_state.projectCounts[meta.project], success, durationMs, details.usage, details);

  // Hourly bucket
  const hourKey = getHourKey();
  let bucket = _state.hourlyBuckets.find(b => b.hour === hourKey);
  if (!bucket) {
    bucket = { hour: hourKey, requests: 0, errors: 0 };
    _state.hourlyBuckets.push(bucket);
    // Keep last 30 days of hourly data (720 buckets)
    if (_state.hourlyBuckets.length > 720) _state.hourlyBuckets.shift();
  }
  bucket.requests++;
  if (!success) bucket.errors++;
  addUsage(bucket, details.usage, details);

  scheduleSave();
}

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor(sortedArr.length * p));
  return sortedArr[idx];
}

/** Get all stats, with computed latency percentiles per model. */
export function getStats() {
  ensureStateShape();
  const out = { ..._state };
  out.modelCounts = {};
  for (const [m, s] of Object.entries(_state.modelCounts)) {
    const sorted = (s.recentMs || []).slice().sort((a, b) => a - b);
    out.modelCounts[m] = {
      requests: s.requests,
      success: s.success,
      errors: s.errors,
      totalMs: s.totalMs,
      avgMs: s.requests > 0 ? Math.round(s.totalMs / s.requests) : 0,
      p50Ms: Math.round(percentile(sorted, 0.5)),
      p95Ms: Math.round(percentile(sorted, 0.95)),
      usage: ensureUsage(s),
    };
  }
  out.accountCounts = Object.fromEntries(Object.entries(_state.accountCounts || {}).map(([k, s]) => [k, { ...ensureCounter(s), recentMs: undefined }]));
  out.tokenCounts = Object.fromEntries(Object.entries(_state.tokenCounts || {}).map(([k, s]) => [k, { ...ensureCounter(s), recentMs: undefined }]));
  out.deviceCounts = Object.fromEntries(Object.entries(_state.deviceCounts || {}).map(([k, s]) => [k, { ...ensureCounter(s), recentMs: undefined }]));
  out.projectCounts = Object.fromEntries(Object.entries(_state.projectCounts || {}).map(([k, s]) => [k, { ...ensureCounter(s), recentMs: undefined }]));
  out.usageTotals = ensureUsage(_state);
  return out;
}

/** Reset all stats. */
export function resetStats() {
  _state.totalRequests = 0;
  _state.successCount = 0;
  _state.errorCount = 0;
  _state.modelCounts = {};
  _state.accountCounts = {};
  _state.tokenCounts = {};
  _state.deviceCounts = {};
  _state.projectCounts = {};
  _state.usageTotals = emptyUsage();
  _state.usage = emptyUsage();
  _state.hourlyBuckets = [];
  _state.startedAt = Date.now();
  scheduleSave();
}
