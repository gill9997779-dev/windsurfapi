import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { addAccountByKey, configureBindHost, removeAccount } from '../src/auth.js';
import { recordRequest, resetStats } from '../src/dashboard/stats.js';
import {
  buildBatchProxyBinding,
  extractPlaygroundResponseText,
  handleDashboardApi,
  setPlaygroundChatHandlerForTest,
  shouldSkipDuplicateBatchEmail,
} from '../src/dashboard/api.js';

const originalDashboardPassword = config.dashboardPassword;
const originalApiKey = config.apiKey;
const createdAccountIds = [];

afterEach(() => {
  config.dashboardPassword = originalDashboardPassword;
  config.apiKey = originalApiKey;
  configureBindHost('0.0.0.0');
  setPlaygroundChatHandlerForTest(null);
  resetStats();
  while (createdAccountIds.length) removeAccount(createdAccountIds.pop());
});

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; },
    end(chunk) { this.body += chunk ? String(chunk) : ''; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

describe('dashboard batch import proxy binding', () => {
  it('uses nested result.account.id from processWindsurfLogin output', () => {
    const binding = buildBatchProxyBinding(
      { success: true, account: { id: 'acct_123' } },
      'socks5://user:pass@proxy.example.com:1080'
    );
    assert.equal(binding.accountId, 'acct_123');
    assert.deepEqual(binding.proxy, {
      type: 'socks5',
      host: 'proxy.example.com',
      port: 1080,
      username: 'user',
      password: 'pass',
    });
  });

  it('fails closed for dashboard write APIs without auth on non-localhost binds', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('DELETE', '/cache', {}, { headers: {} }, res);

    assert.equal(res.statusCode, 401);
    assert.match(res.json().error, /Unauthorized/);
  });

  it('allows unauthenticated dashboard writes only on localhost binds', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    const res = fakeRes();
    await handleDashboardApi('GET', '/cache', {}, { headers: {} }, res);

    assert.equal(res.statusCode, 200);
  });

  it('accepts dashboard auth headers with timing-safe configured secrets', async () => {
    config.dashboardPassword = 'dash-secret';
    config.apiKey = '';
    configureBindHost('0.0.0.0');

    const res = fakeRes();
    await handleDashboardApi('GET', '/cache', {}, { headers: { 'x-dashboard-password': 'dash-secret' } }, res);

    assert.equal(res.statusCode, 200);
  });

  it('normalizes batch emails but does not pre-skip duplicate logins', () => {
    const seen = new Set();
    assert.deepEqual(shouldSkipDuplicateBatchEmail(seen, 'User@Example.com', true), {
      skip: false,
      normalizedEmail: 'user@example.com',
    });
    assert.deepEqual(shouldSkipDuplicateBatchEmail(seen, 'user@example.com', true), {
      skip: false,
      normalizedEmail: 'user@example.com',
    });
    assert.deepEqual(shouldSkipDuplicateBatchEmail(seen, 'user@example.com', false), {
      skip: false,
      normalizedEmail: 'user@example.com',
    });
    assert.equal(seen.has('user@example.com'), true);
  });

  it('extracts assistant text from multipart playground responses', () => {
    assert.equal(extractPlaygroundResponseText({
      choices: [{
        message: {
          content: [
            { type: 'output_text', text: 'hello' },
            { type: 'output_text', text: 'world' },
          ],
        },
      }],
    }), 'hello\nworld');
  });

  it('proxies dashboard playground requests through the chat handler', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');
    const account = addAccountByKey('playground-test-key', 'playground@test.local');
    createdAccountIds.push(account.id);

    let seenBody = null;
    let seenContext = null;
    setPlaygroundChatHandlerForTest(async (body, context) => {
      seenBody = body;
      seenContext = context;
      return {
        status: 200,
        body: {
          model: body.model,
          choices: [{
            finish_reason: 'stop',
            message: { content: 'pong' },
          }],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
          },
        },
      };
    });

    const res = fakeRes();
    await handleDashboardApi('POST', '/playground/chat', {
      model: 'gpt-5.5',
      system: 'be concise',
      prompt: 'ping',
      maxTokens: 77,
      temperature: 0.4,
    }, { headers: {} }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(seenBody, {
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'ping' },
      ],
      stream: false,
      max_tokens: 77,
      temperature: 0.4,
    });
    assert.match(seenContext.callerKey, /^session:dashboard-playground-/);
    assert.equal(seenContext.statsContext.project, 'dashboard-playground');
    assert.deepEqual(res.json(), {
      success: true,
      model: 'gpt-5.5',
      text: 'pong',
      usage: {
        prompt_tokens: 3,
        completion_tokens: 1,
        total_tokens: 4,
      },
      finishReason: 'stop',
      response: {
        model: 'gpt-5.5',
        choices: [{
          finish_reason: 'stop',
          message: { content: 'pong' },
        }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 1,
          total_tokens: 4,
        },
      },
    });
  });

  it('returns pricing summary data from the stats endpoint', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    recordRequest('gpt-5.5', true, 123, 'acct_pricing', {
      usage: {
        prompt_tokens: 120000,
        completion_tokens: 40000,
        total_tokens: 160000,
        cache_read_input_tokens: 30000,
        cache_creation_input_tokens: 10000,
      },
    });
    recordRequest('swe-1-6', false, 456, 'acct_unpriced', {
      usage: {
        prompt_tokens: 50000,
        completion_tokens: 10000,
        total_tokens: 60000,
      },
    });

    const res = fakeRes();
    await handleDashboardApi('GET', '/stats', {}, { headers: {} }, res);

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.pricingSummary.pricedModels, 2);
    assert.equal(body.pricingSummary.officialModels, 1);
    assert.equal(body.pricingSummary.estimatedModels, 1);
    assert.equal(body.pricingSummary.totalModels, 2);
    assert.equal(body.modelCounts['gpt-5.5'].pricing.available, true);
    assert.equal(body.modelCounts['swe-1-6'].pricing.available, true);
    assert.equal(body.modelCounts['swe-1-6'].pricing.catalogStatus, 'estimated');
    assert.equal(body.pricingSummary.unpricedModels.length, 0);
    assert.ok(body.pricingSummary.totalUsd > 0);
    assert.ok(body.pricingSummary.totalCny > 0);
    assert.ok(body.pricingFx.usdToCny > 0);
  });

  it('returns the model pricing catalog endpoint for the pricing page', async () => {
    config.dashboardPassword = '';
    config.apiKey = '';
    configureBindHost('127.0.0.1');

    const res = fakeRes();
    await handleDashboardApi('GET', '/pricing', {}, { headers: {} }, res);

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(Array.isArray(body.entries), true);
    assert.equal(body.entries.some((entry) => entry.id === 'gpt-5.5' && entry.available), true);
    assert.equal(body.entries.some((entry) => entry.id === 'swe-1.6' && entry.catalogStatus === 'estimated' && entry.available === true), true);
    assert.ok(body.summary.totalModels >= 40);
    assert.ok(body.summary.exactModels > 0);
    assert.ok(body.summary.estimatedModels > 0);
    assert.ok(body.pricingFx.usdToCny > 0);
  });
});
