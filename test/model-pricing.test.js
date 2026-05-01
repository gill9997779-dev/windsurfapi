import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { estimateModelSpend, listModelPricingCatalog, summarizeStatsSpend } from '../src/dashboard/model-pricing.js';

const originalFxRate = process.env.STATS_USD_CNY_RATE;
const originalFxSource = process.env.STATS_USD_CNY_SOURCE;
const originalFxDate = process.env.STATS_USD_CNY_DATE;

afterEach(() => {
  if (originalFxRate === undefined) delete process.env.STATS_USD_CNY_RATE;
  else process.env.STATS_USD_CNY_RATE = originalFxRate;
  if (originalFxSource === undefined) delete process.env.STATS_USD_CNY_SOURCE;
  else process.env.STATS_USD_CNY_SOURCE = originalFxSource;
  if (originalFxDate === undefined) delete process.env.STATS_USD_CNY_DATE;
  else process.env.STATS_USD_CNY_DATE = originalFxDate;
});

describe('dashboard model pricing', () => {
  it('prices standard input, cache read, cache write, and output separately for GPT-5.5', () => {
    const pricing = estimateModelSpend('gpt-5.5-xhigh', {
      promptTokens: 1_200_000,
      completionTokens: 300_000,
      cacheReadTokens: 400_000,
      cacheWriteTokens: 100_000,
    });

    assert.equal(pricing.available, true);
    assert.deepEqual(pricing.chargeableTokens, {
      prompt: 1_200_000,
      freshInput: 700_000,
      cacheRead: 400_000,
      cacheWrite: 100_000,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 300_000,
    });
    assert.deepEqual(pricing.usd, {
      input: 3.5,
      cacheRead: 0.2,
      cacheWrite: 0.5,
      output: 9,
      total: 13.2,
    });
  });

  it('applies Anthropic cache-write tiers when usage exposes 5m and 1h buckets', () => {
    const pricing = estimateModelSpend('claude-sonnet-4.6-thinking-1m', {
      promptTokens: 2_000_000,
      completionTokens: 200_000,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 700_000,
      cacheWrite5mTokens: 300_000,
      cacheWrite1hTokens: 200_000,
    });

    assert.equal(pricing.available, true);
    assert.equal(pricing.unitUsdPerM.input, 3);
    assert.ok(Math.abs(pricing.unitUsdPerM.cacheRead - 0.3) < 1e-12);
    assert.equal(pricing.unitUsdPerM.cacheWrite5m, 3.75);
    assert.equal(pricing.unitUsdPerM.cacheWrite1h, 6);
    assert.equal(pricing.chargeableTokens.freshInput, 800_000);
    assert.equal(pricing.chargeableTokens.cacheWrite5m, 300_000);
    assert.equal(pricing.chargeableTokens.cacheWrite1h, 200_000);
    assert.equal(pricing.usd.total, 8.625);
  });

  it('treats local response-cache hits as zero upstream spend', () => {
    const pricing = estimateModelSpend('minimax-m2-5', {
      promptTokens: 900_000,
      completionTokens: 120_000,
      cacheReadTokens: 900_000,
      localCachePromptTokens: 900_000,
      localCacheCompletionTokens: 120_000,
    });

    assert.equal(pricing.available, true);
    assert.deepEqual(pricing.localCacheTokens, {
      prompt: 900_000,
      output: 120_000,
    });
    assert.deepEqual(pricing.usd, {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      total: 0,
    });
  });

  it('summarizes priced and unpriced model families separately', () => {
    process.env.STATS_USD_CNY_RATE = '7.2';
    process.env.STATS_USD_CNY_SOURCE = 'test-fx';
    process.env.STATS_USD_CNY_DATE = '2026-05-01';

    const summary = summarizeStatsSpend({
      modelCounts: {
        'gpt-5.5': {
          requests: 3,
          usage: {
            totalTokens: 160_000,
            promptTokens: 120_000,
            completionTokens: 40_000,
            cacheReadTokens: 30_000,
            cacheWriteTokens: 10_000,
          },
        },
        'swe-1-6': {
          requests: 2,
          usage: {
            totalTokens: 60_000,
            promptTokens: 50_000,
            completionTokens: 10_000,
          },
        },
      },
    });

    assert.equal(summary.modelCounts['gpt-5.5'].pricing.available, true);
    assert.equal(summary.modelCounts['swe-1-6'].pricing.available, true);
    assert.equal(summary.modelCounts['swe-1-6'].pricing.catalogStatus, 'estimated');
    assert.equal(summary.pricingSummary.pricedModels, 2);
    assert.equal(summary.pricingSummary.officialModels, 1);
    assert.equal(summary.pricingSummary.estimatedModels, 1);
    assert.equal(summary.pricingSummary.totalModels, 2);
    assert.equal(summary.pricingSummary.pricedRequests, 5);
    assert.equal(summary.pricingSummary.unpricedRequests, 0);
    assert.equal(summary.pricingSummary.unpricedModels.length, 0);
    assert.equal(summary.pricingSummary.totalUsd, 1.695);
    assert.equal(summary.pricingSummary.totalCny, 12.204);
    assert.deepEqual(summary.pricingFx, {
      usdToCny: 7.2,
      source: 'test-fx',
      date: '2026-05-01',
    });
  });

  it('lists the pricing catalog for the frontend pricing page', () => {
    process.env.STATS_USD_CNY_RATE = '7.1';

    const catalog = listModelPricingCatalog();
    const gpt = catalog.entries.find((entry) => entry.id === 'gpt-5.5');
    const qwen = catalog.entries.find((entry) => entry.id === 'qwen-3');
    const codexMini = catalog.entries.find((entry) => entry.id === 'gpt-5.1-codex-mini');
    const windsurf = catalog.entries.find((entry) => entry.id === 'swe-1.6');
    const arena = catalog.entries.find((entry) => entry.id === 'arena-fast');

    assert.equal(catalog.summary.totalModels >= 40, true);
    assert.equal(catalog.summary.exactModels > 0, true);
    assert.equal(catalog.summary.estimatedModels > 0, true);
    assert.equal(catalog.summary.referenceModels > 0, true);
    assert.equal(gpt.available, true);
    assert.equal(gpt.catalogStatus, 'exact');
    assert.equal(gpt.unitUsdPerM.output, 30);
    assert.equal(gpt.unitCnyPerM.input, 35.5);
    assert.equal(codexMini.catalogStatus, 'exact');
    assert.equal(qwen.available, true);
    assert.equal(qwen.catalogStatus, 'estimated');
    assert.equal(qwen.unitUsdPerM.input, 1.2);
    assert.equal(windsurf.available, true);
    assert.equal(windsurf.catalogStatus, 'estimated');
    assert.equal(windsurf.unitUsdPerM.output, 1.5);
    assert.equal(arena.catalogStatus, 'reference');
  });
});
