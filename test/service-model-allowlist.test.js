import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureBindHost } from '../src/auth.js';
import { config } from '../src/config.js';
import { handleChatCompletions } from '../src/handlers/chat.js';
import { handleDashboardApi } from '../src/dashboard/api.js';
import { SERVICE_MODEL_ALLOWLIST, listModels, toPublicModelId } from '../src/models.js';
import { proxyModesFor } from '../src/windsurf-api.js';

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; },
    end(data) { this.body = data || ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

describe('service model allowlist', () => {
  it('limits OpenAI-compatible /v1/models to GPT-5.5 high and xhigh', () => {
    const ids = listModels().map(m => m._windsurf_id).sort();
    assert.deepEqual(ids, [...SERVICE_MODEL_ALLOWLIST].sort());
  });

  it('limits dashboard model list to GPT-5.5 high and xhigh', async () => {
    configureBindHost('127.0.0.1');
    const res = fakeRes();
    await handleDashboardApi(
      'GET',
      '/models',
      null,
      { headers: { 'x-dashboard-password': config.dashboardPassword || config.apiKey }, socket: { remoteAddress: '127.0.0.1' } },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().models.map(m => m.id).sort(), SERVICE_MODEL_ALLOWLIST.map(toPublicModelId).sort());
    assert.deepEqual(res.json().models.map(m => m._windsurf_id).sort(), [...SERVICE_MODEL_ALLOWLIST].sort());
  });

  it('rejects chat requests for non-allowlisted models before account checkout', async () => {
    const result = await handleChatCompletions({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'model_not_allowed');
  });
});

describe('proxy direct fallback', () => {
  it('does not fall back to direct when a proxy is configured by default', () => {
    const old = process.env.WINDSURFAPI_PROXY_DIRECT_FALLBACK;
    delete process.env.WINDSURFAPI_PROXY_DIRECT_FALLBACK;
    try {
      const proxy = { type: 'http', host: 'proxy.example.com', port: 8080 };
      assert.deepEqual(proxyModesFor(proxy), [proxy]);
      assert.deepEqual(proxyModesFor(null), [null]);
    } finally {
      if (old == null) delete process.env.WINDSURFAPI_PROXY_DIRECT_FALLBACK;
      else process.env.WINDSURFAPI_PROXY_DIRECT_FALLBACK = old;
    }
  });

  it('allows direct fallback only when explicitly enabled', () => {
    const old = process.env.WINDSURFAPI_PROXY_DIRECT_FALLBACK;
    process.env.WINDSURFAPI_PROXY_DIRECT_FALLBACK = '1';
    try {
      const proxy = { type: 'http', host: 'proxy.example.com', port: 8080 };
      assert.deepEqual(proxyModesFor(proxy), [proxy, null]);
    } finally {
      if (old == null) delete process.env.WINDSURFAPI_PROXY_DIRECT_FALLBACK;
      else process.env.WINDSURFAPI_PROXY_DIRECT_FALLBACK = old;
    }
  });
});
