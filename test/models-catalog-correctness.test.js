import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODELS,
  resolveModel,
  getModelInfo,
  mergeCloudModels,
} from '../src/models.js';

describe('v2.0.29 model catalog correctness', () => {
  it('maps opus-4.7 shorthand aliases to canonical 4.7 medium keys', () => {
    assert.equal(resolveModel('opus-4.7'), 'claude-opus-4-7-medium');
    assert.equal(resolveModel('o4.7'), 'claude-opus-4-7-medium');
    assert.equal(resolveModel('claude-opus-4.7'), 'claude-opus-4-7-medium');
  });

  it('maps opus-4.7 thinking aliases to medium-thinking canonical key', () => {
    assert.equal(resolveModel('opus-4.7-thinking'), 'claude-opus-4-7-medium-thinking');
    assert.equal(resolveModel('claude-opus-4.7-thinking'), 'claude-opus-4-7-medium-thinking');
    assert.equal(resolveModel('claude-opus-4.7-high-thinking'), 'claude-opus-4-7-high-thinking');
  });

  it('keeps new v2.0.29 model metadata aligned with declared keys', () => {
    assert.equal(getModelInfo('kimi-k2-thinking')?.modelUid, 'MODEL_KIMI_K2_THINKING');
    assert.equal(getModelInfo('kimi-k2-thinking')?.enumValue, 394);
    assert.equal(getModelInfo('kimi-k2-thinking')?.credit, 1);
    assert.equal(getModelInfo('glm-4.7-fast')?.enumValue, 418);
    assert.equal(getModelInfo('glm-4.7-fast')?.modelUid, 'MODEL_GLM_4_7_FAST');
  });

  it('validates swe and minimax enum updates from release payload', () => {
    assert.equal(getModelInfo('swe-1.5-thinking')?.enumValue, 369);
    assert.equal(getModelInfo('swe-1.5')?.enumValue, 377);
    assert.equal(getModelInfo('swe-1.6')?.enumValue, 420);
    assert.equal(getModelInfo('swe-1.6')?.modelUid, 'swe-1-6');
    assert.equal(getModelInfo('swe-1.6-fast')?.enumValue, 421);
    assert.equal(getModelInfo('swe-1.6-fast')?.modelUid, 'swe-1-6-fast');
    assert.equal(getModelInfo('minimax-m2.5')?.enumValue, 419);
    assert.equal(getModelInfo('minimax-m2.5')?.modelUid, 'minimax-m2-5');
    assert.equal(resolveModel('MODEL_SWE_1_6'), 'swe-1.6');
    assert.equal(resolveModel('MODEL_SWE_1_6_FAST'), 'swe-1.6-fast');
    assert.equal(resolveModel('MODEL_MINIMAX_M2_1'), 'minimax-m2.5');
  });

  it('supports adaptive as explicit model for dynamic routing', () => {
    assert.equal(resolveModel('adaptive'), 'adaptive');
    assert.equal(getModelInfo('adaptive')?.enumValue, 0);
    assert.equal(getModelInfo('adaptive')?.credit, 1);
  });

  it('mergeCloudModels should skip already-known model UIDs (dedupe path)', () => {
    const before = Object.keys(MODELS).length;
    const dynamicUid = 'NEW_MODEL_4_7_TEST';
    const dynamicKey = dynamicUid.toLowerCase().replace(/_/g, '-');
    const summary = mergeCloudModels([
      { provider: 'MODEL_PROVIDER_OPENAI', modelUid: 'claude-opus-4-7-medium-thinking', creditMultiplier: 999 },
      { provider: 'MODEL_PROVIDER_OPENAI', modelUid: dynamicUid, creditMultiplier: 3 },
    ]);
    const after = Object.keys(MODELS).length;

    assert.equal(summary.added, 1);
    assert.equal(after - before, 1);
    try {
      assert.equal(getModelInfo(dynamicKey)?.credit, 3);
    } finally {
      if (MODELS[dynamicKey]) {
        delete MODELS[dynamicKey];
      }
    }
  });

  it('reconciles stale cloud UIDs and family-default aliases', () => {
    const swe = getModelInfo('swe-1.6');
    const minimax = getModelInfo('minimax-m2.5');
    const gpt = getModelInfo('gpt-5.5');

    const old = {
      sweUid: swe?.modelUid,
      minimaxUid: minimax?.modelUid,
      gptUid: gpt?.modelUid,
      gptCredit: gpt?.credit,
    };

    try {
      if (swe) swe.modelUid = 'MODEL_SWE_1_6';
      if (minimax) minimax.modelUid = 'MODEL_MINIMAX_M2_1';
      if (gpt) {
        gpt.modelUid = 'gpt-5-5-medium';
        gpt.credit = 2;
      }

      const summary = mergeCloudModels([
        { label: 'SWE-1.6', modelUid: 'swe-1-6', provider: 'MODEL_PROVIDER_WINDSURF', creditMultiplier: 0.5 },
        { label: 'Minimax M2.5', modelUid: 'minimax-m2-5', creditMultiplier: 1 },
        {
          label: 'GPT-5.5 Low Thinking',
          modelUid: 'gpt-5-5-low',
          provider: 'MODEL_PROVIDER_OPENAI',
          creditMultiplier: 8,
          isDefaultModelInFamily: true,
          modelInfo: { modelFamilyUid: 'gpt-5.5' },
          modelFamilyMetadata: { modelFamilyLabel: 'GPT-5.5' },
        },
      ]);

      assert.ok(summary.updated >= 2);
      assert.ok(summary.defaulted >= 1);
      assert.equal(getModelInfo('swe-1.6')?.modelUid, 'swe-1-6');
      assert.equal(getModelInfo('minimax-m2.5')?.modelUid, 'minimax-m2-5');
      assert.equal(getModelInfo('gpt-5.5')?.modelUid, 'gpt-5-5-low');
      assert.equal(getModelInfo('gpt-5.5')?.credit, 8);
      assert.equal(resolveModel('MODEL_SWE_1_6'), 'swe-1.6');
      assert.equal(resolveModel('MODEL_MINIMAX_M2_1'), 'minimax-m2.5');
    } finally {
      if (swe && old.sweUid) swe.modelUid = old.sweUid;
      if (minimax && old.minimaxUid) minimax.modelUid = old.minimaxUid;
      if (gpt) {
        gpt.modelUid = old.gptUid;
        gpt.credit = old.gptCredit;
      }
    }
  });
});
