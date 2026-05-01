import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getOrCreateLsAccountState, workspaceIdForApiKey } from '../src/client.js';

describe('WindsurfClient per-account LS runtime state', () => {
  it('keeps separate runtime buckets for different api keys on the same LS entry', () => {
    const entry = {};
    const a = getOrCreateLsAccountState(entry, 'api-key-a');
    const b = getOrCreateLsAccountState(entry, 'api-key-b');

    assert.ok(entry.accountStates instanceof Map);
    assert.notEqual(a, b);

    a.sessionId = 'session-a';
    a.workspaceInit = Promise.resolve('a');
    b.sessionId = 'session-b';

    assert.equal(getOrCreateLsAccountState(entry, 'api-key-a').sessionId, 'session-a');
    assert.equal(getOrCreateLsAccountState(entry, 'api-key-b').sessionId, 'session-b');
    assert.equal(entry.accountStates.size, 2);
  });

  it('derives stable, distinct workspace ids from api keys', () => {
    const a1 = workspaceIdForApiKey('api-key-a');
    const a2 = workspaceIdForApiKey('api-key-a');
    const b = workspaceIdForApiKey('api-key-b');

    assert.equal(a1, a2);
    assert.notEqual(a1, b);
    assert.match(a1, /^[0-9a-f]{12}$/);
  });
});
