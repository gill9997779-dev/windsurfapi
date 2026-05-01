import { MODELS } from '../models.js';

const DEFAULT_USD_TO_CNY = 7.9993 / 1.1706; // ECB reference rates for 2026-04-29
const DEFAULT_USD_TO_CNY_DATE = '2026-04-29';
const DEFAULT_USD_TO_CNY_SOURCE = 'ECB euro reference rates';

const PROVIDER_ORDER = ['anthropic', 'openai', 'google', 'deepseek', 'xai', 'alibaba', 'moonshot', 'zhipu', 'minimax', 'windsurf', 'unknown'];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function roundMoney(value) {
  return Math.round((num(value) + Number.EPSILON) * 10000) / 10000;
}

function usdToCnyRate() {
  const env = Number(process.env.STATS_USD_CNY_RATE || '');
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_USD_TO_CNY;
}

export function pricingFx() {
  return {
    usdToCny: usdToCnyRate(),
    source: process.env.STATS_USD_CNY_SOURCE || DEFAULT_USD_TO_CNY_SOURCE,
    date: process.env.STATS_USD_CNY_DATE || DEFAULT_USD_TO_CNY_DATE,
  };
}

function normalizeModelId(model) {
  return String(model || '').trim().toLowerCase().replace(/[_.\s]+/g, '-');
}

function cnyToUsd(value) {
  return num(value) / usdToCnyRate();
}

function convertUnitBlock(units, rate) {
  if (!units) return null;
  return Object.fromEntries(
    Object.entries(units).map(([k, v]) => [k, Number.isFinite(v) ? roundMoney(v * rate) : null])
  );
}

function providerForModel(model) {
  const raw = String(model || '').trim();
  if (MODELS[raw]?.provider) return MODELS[raw].provider;
  const id = normalizeModelId(raw);
  if (id.startsWith('claude')) return 'anthropic';
  if (id.startsWith('gpt') || id.startsWith('o3') || id.startsWith('o4')) return 'openai';
  if (id.startsWith('gemini')) return 'google';
  if (id.startsWith('deepseek')) return 'deepseek';
  if (id.startsWith('grok')) return 'xai';
  if (id.startsWith('qwen')) return 'alibaba';
  if (id.startsWith('kimi')) return 'moonshot';
  if (id.startsWith('glm')) return 'zhipu';
  if (id.startsWith('minimax') || /^m2(?:-|$)/.test(id)) return 'minimax';
  if (id.startsWith('swe') || id.startsWith('adaptive') || id.startsWith('arena')) return 'windsurf';
  return 'unknown';
}

function exactRule({
  provider,
  label,
  source,
  inputUsdPerM,
  outputUsdPerM,
  cacheReadUsdPerM,
  cacheWrite5mUsdPerM = null,
  cacheWrite1hUsdPerM = null,
  cacheWriteFallbackUsdPerM = null,
  catalogStatus = 'exact',
  exactForStats = catalogStatus === 'exact',
}) {
  return {
    available: true,
    provider,
    label,
    source,
    catalogStatus,
    exactForStats,
    inputUsdPerM,
    outputUsdPerM,
    cacheReadUsdPerM,
    cacheWrite5mUsdPerM,
    cacheWrite1hUsdPerM,
    cacheWriteFallbackUsdPerM,
  };
}

function anthropicRule(label, input, output, opts = {}) {
  return exactRule({
    provider: 'anthropic',
    label,
    source: opts.source || 'https://platform.claude.com/docs/en/about-claude/pricing',
    catalogStatus: opts.catalogStatus,
    exactForStats: opts.exactForStats,
    inputUsdPerM: input,
    outputUsdPerM: output,
    cacheReadUsdPerM: opts.cacheReadUsdPerM ?? input * 0.1,
    cacheWrite5mUsdPerM: opts.cacheWrite5mUsdPerM ?? input * 1.25,
    cacheWrite1hUsdPerM: opts.cacheWrite1hUsdPerM ?? input * 2,
    cacheWriteFallbackUsdPerM: opts.cacheWriteFallbackUsdPerM ?? input * 1.25,
  });
}

function openAiRule(label, input, cachedInput, output, opts = {}) {
  return exactRule({
    provider: 'openai',
    label,
    source: opts.source || 'https://openai.com/api/pricing/',
    catalogStatus: opts.catalogStatus,
    exactForStats: opts.exactForStats,
    inputUsdPerM: input,
    outputUsdPerM: output,
    cacheReadUsdPerM: cachedInput,
    // OpenAI only posts a cached-input rate; newly-created cache is billed
    // as normal input in the live API pricing table.
    cacheWriteFallbackUsdPerM: input,
  });
}

function googleRule(label, input, cachedInput, output, opts = {}) {
  return exactRule({
    provider: 'google',
    label,
    source: opts.source || 'https://ai.google.dev/gemini-api/docs/pricing',
    catalogStatus: opts.catalogStatus,
    exactForStats: opts.exactForStats,
    inputUsdPerM: input,
    outputUsdPerM: output,
    cacheReadUsdPerM: cachedInput,
    // Gemini publishes cache read token pricing plus a separate hourly
    // storage fee. We can price token reads, but storage-hours are not
    // represented in current request usage telemetry.
    cacheWriteFallbackUsdPerM: input,
  });
}

function deepSeekRule(label, input, cacheRead, output, opts = {}) {
  return exactRule({
    provider: 'deepseek',
    label,
    source: opts.source || 'https://api-docs.deepseek.com/quick_start/pricing-details-usd/',
    catalogStatus: opts.catalogStatus,
    exactForStats: opts.exactForStats,
    inputUsdPerM: input,
    outputUsdPerM: output,
    cacheReadUsdPerM: cacheRead,
    cacheWriteFallbackUsdPerM: input,
  });
}

function miniMaxRule(label, input, output, cacheRead, cacheWrite, opts = {}) {
  return exactRule({
    provider: 'minimax',
    label,
    source: opts.source || 'https://platform.minimaxi.com/docs/guides/pricing-paygo',
    catalogStatus: opts.catalogStatus,
    exactForStats: opts.exactForStats,
    inputUsdPerM: input,
    outputUsdPerM: output,
    cacheReadUsdPerM: cacheRead,
    cacheWriteFallbackUsdPerM: cacheWrite,
  });
}

function kimiRule(label, inputCnyPerM, cacheReadCnyPerM, outputCnyPerM, opts = {}) {
  return exactRule({
    provider: 'moonshot',
    label,
    source: opts.source || 'https://platform.kimi.com/docs/pricing/chat-k2',
    catalogStatus: opts.catalogStatus,
    exactForStats: opts.exactForStats,
    inputUsdPerM: cnyToUsd(inputCnyPerM),
    outputUsdPerM: cnyToUsd(outputCnyPerM),
    cacheReadUsdPerM: cnyToUsd(cacheReadCnyPerM),
    // Kimi publishes cache-hit pricing but no separate cache-write surcharge.
    cacheWriteFallbackUsdPerM: cnyToUsd(inputCnyPerM),
  });
}

function xAiRule(label, input, cachedInput, output, opts = {}) {
  return exactRule({
    provider: 'xai',
    label,
    source: opts.source || 'https://docs.x.ai/developers/models',
    catalogStatus: opts.catalogStatus,
    exactForStats: opts.exactForStats,
    inputUsdPerM: input,
    outputUsdPerM: output,
    cacheReadUsdPerM: cachedInput,
    cacheWriteFallbackUsdPerM: opts.cacheWriteFallbackUsdPerM ?? input,
  });
}

function alibabaRule(label, input, cachedInput, output, opts = {}) {
  return exactRule({
    provider: 'alibaba',
    label,
    source: opts.source || 'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
    catalogStatus: opts.catalogStatus,
    exactForStats: opts.exactForStats,
    inputUsdPerM: input,
    outputUsdPerM: output,
    cacheReadUsdPerM: cachedInput,
    cacheWriteFallbackUsdPerM: opts.cacheWriteFallbackUsdPerM ?? input,
  });
}

function zhipuRule(label, input, output, opts = {}) {
  return exactRule({
    provider: 'zhipu',
    label,
    source: opts.source || 'https://www.alibabacloud.com/help/en/model-studio/model-pricing',
    catalogStatus: opts.catalogStatus,
    exactForStats: opts.exactForStats,
    inputUsdPerM: input,
    outputUsdPerM: output,
    cacheReadUsdPerM: opts.cacheReadUsdPerM ?? input,
    cacheWriteFallbackUsdPerM: opts.cacheWriteFallbackUsdPerM ?? input,
  });
}

function unavailableRule(provider, reason, source = '') {
  return { available: false, provider, reason, source };
}

function referenceCatalogEntry({
  id,
  provider,
  family,
  matchDisplay,
  source = '',
  reason = 'reference_only',
  displayUsdPerM = {},
  displayCnyPerM = {},
  cacheWriteMode = 'display',
  note = '',
}) {
  return {
    id,
    provider,
    family,
    matchDisplay,
    available: false,
    exactForStats: false,
    catalogStatus: reason === 'no_public_token_price' ? 'no_public_price' : 'reference',
    reason,
    source,
    cacheWriteMode,
    unitUsdPerM: null,
    unitCnyPerM: null,
    displayUsdPerM,
    displayCnyPerM,
    note,
  };
}

const EXACT_SPECS = [
  {
    id: 'claude-4.5-haiku',
    family: 'Claude Haiku 4.5',
    matchDisplay: 'Claude 4.5 Haiku',
    cacheWriteMode: 'tiered',
    matches: (id) => id === 'claude-4-5-haiku',
    buildRule: () => anthropicRule('Claude Haiku 4.5', 1, 5),
  },
  {
    id: 'claude-3.5-sonnet',
    family: 'Claude Sonnet 3.5',
    matchDisplay: 'Claude 3.5 Sonnet',
    cacheWriteMode: 'tiered',
    matches: (id) => id === 'claude-3-5-sonnet',
    buildRule: () => anthropicRule('Claude Sonnet 3.5', 3, 15, {
      catalogStatus: 'estimated',
      exactForStats: false,
    }),
    note: 'Estimated from the current Claude Sonnet family because Anthropic no longer lists Sonnet 3.5 separately on the live pricing page.',
  },
  {
    id: 'claude-3.7-sonnet',
    family: 'Claude Sonnet 3.7',
    matchDisplay: 'Claude 3.7 Sonnet',
    cacheWriteMode: 'tiered',
    matches: (id) => /^claude-3-7-sonnet(?:-thinking)?$/.test(id),
    buildRule: () => anthropicRule('Claude Sonnet 3.7', 3, 15),
  },
  {
    id: 'claude-4-sonnet',
    family: 'Claude Sonnet 4',
    matchDisplay: 'Claude Sonnet 4',
    cacheWriteMode: 'tiered',
    matches: (id) => /^claude-4-sonnet(?:-thinking)?$/.test(id),
    buildRule: () => anthropicRule('Claude Sonnet 4', 3, 15),
  },
  {
    id: 'claude-4.5-sonnet',
    family: 'Claude Sonnet 4.5',
    matchDisplay: 'Claude Sonnet 4.5',
    cacheWriteMode: 'tiered',
    matches: (id) => /^claude-4-5-sonnet(?:-thinking)?$/.test(id),
    buildRule: () => anthropicRule('Claude Sonnet 4.5', 3, 15),
  },
  {
    id: 'claude-sonnet-4.6',
    family: 'Claude Sonnet 4.6',
    matchDisplay: 'Claude Sonnet 4.6',
    cacheWriteMode: 'tiered',
    matches: (id) => /^claude(?:-sonnet)?-4-6(?:-thinking)?(?:-1m)?$/.test(id),
    buildRule: () => anthropicRule('Claude Sonnet 4.6', 3, 15),
  },
  {
    id: 'claude-4-opus',
    family: 'Claude Opus 4',
    matchDisplay: 'Claude Opus 4',
    cacheWriteMode: 'tiered',
    matches: (id) => /^claude-4-opus(?:-thinking)?$/.test(id),
    buildRule: () => anthropicRule('Claude Opus 4', 15, 75),
  },
  {
    id: 'claude-4.1-opus',
    family: 'Claude Opus 4.1',
    matchDisplay: 'Claude Opus 4.1',
    cacheWriteMode: 'tiered',
    matches: (id) => /^claude-4-1-opus(?:-thinking)?$/.test(id),
    buildRule: () => anthropicRule('Claude Opus 4.1', 15, 75),
  },
  {
    id: 'claude-4.5-opus',
    family: 'Claude Opus 4.5',
    matchDisplay: 'Claude Opus 4.5',
    cacheWriteMode: 'tiered',
    matches: (id) => /^claude-4-5-opus(?:-thinking)?$/.test(id),
    buildRule: () => anthropicRule('Claude Opus 4.5', 5, 25, {
      source: 'https://www.anthropic.com/news/claude-opus-4-5',
    }),
  },
  {
    id: 'claude-opus-4.6',
    family: 'Claude Opus 4.6',
    matchDisplay: 'Claude Opus 4.6',
    cacheWriteMode: 'tiered',
    matches: (id) => /^claude-opus-4-6(?:-thinking)?$/.test(id),
    buildRule: () => anthropicRule('Claude Opus 4.6', 5, 25, {
      source: 'https://www.anthropic.com/news/claude-opus-4-5',
    }),
  },
  {
    id: 'claude-opus-4.7',
    family: 'Claude Opus 4.7',
    matchDisplay: 'Claude Opus 4.7',
    cacheWriteMode: 'tiered',
    matches: (id) => /^claude-opus-4-7(?:-(?:low|medium|high|xhigh))?(?:-thinking)?$/.test(id),
    buildRule: () => anthropicRule('Claude Opus 4.7', 5, 25, {
      source: 'https://www.anthropic.com/news/claude-opus-4-5',
    }),
  },
  {
    id: 'gpt-4.1-nano',
    family: 'GPT-4.1 nano',
    matchDisplay: 'GPT-4.1 nano',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gpt-4-1-nano',
    buildRule: () => openAiRule('GPT-4.1 nano', 0.1, 0.025, 0.4, {
      source: 'https://openai.com/index/gpt-4-1/',
    }),
  },
  {
    id: 'gpt-4.1-mini',
    family: 'GPT-4.1 mini',
    matchDisplay: 'GPT-4.1 mini',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gpt-4-1-mini',
    buildRule: () => openAiRule('GPT-4.1 mini', 0.4, 0.1, 1.6, {
      source: 'https://openai.com/index/gpt-4-1/',
    }),
  },
  {
    id: 'gpt-4.1',
    family: 'GPT-4.1',
    matchDisplay: 'GPT-4.1',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gpt-4-1',
    buildRule: () => openAiRule('GPT-4.1', 2, 0.5, 8, {
      source: 'https://openai.com/index/gpt-4-1/',
    }),
  },
  {
    id: 'gpt-4o-mini',
    family: 'GPT-4o mini',
    matchDisplay: 'GPT-4o mini',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gpt-4o-mini',
    buildRule: () => openAiRule('GPT-4o mini', 0.15, 0.075, 0.6),
  },
  {
    id: 'gpt-4o',
    family: 'GPT-4o',
    matchDisplay: 'GPT-4o',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gpt-4o',
    buildRule: () => openAiRule('GPT-4o', 2.5, 1.25, 10),
  },
  {
    id: 'gpt-5-mini',
    family: 'GPT-5 mini',
    matchDisplay: 'GPT-5 mini',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gpt-5-mini',
    buildRule: () => openAiRule('GPT-5 mini', 0.25, 0.025, 2),
  },
  {
    id: 'gpt-5',
    family: 'GPT-5 / GPT-5 Codex',
    matchDisplay: 'GPT-5 / GPT-5 Codex',
    cacheWriteMode: 'fallback',
    matches: (id) => /^gpt-5(?:$|-(?![1-5]|mini|nano|pro))/.test(id),
    buildRule: () => openAiRule('GPT-5', 1.25, 0.125, 10),
  },
  {
    id: 'gpt-5.1',
    family: 'GPT-5.1',
    matchDisplay: 'GPT-5.1 and non-mini Codex variants',
    cacheWriteMode: 'fallback',
    matches: (id) => /^gpt-5-1(?:$|-(?!codex-mini))/.test(id),
    buildRule: () => openAiRule('GPT-5.1', 1.25, 0.125, 10),
  },
  {
    id: 'gpt-5.1-codex-mini',
    family: 'GPT-5.1 Codex mini',
    matchDisplay: 'GPT-5.1 Codex mini',
    cacheWriteMode: 'fallback',
    matches: (id) => /^gpt-5-1-codex-mini(?:-low)?$/.test(id),
    buildRule: () => openAiRule('GPT-5.1 Codex mini', 0.25, 0.025, 2, {
      source: 'https://developers.openai.com/api/docs/models/gpt-5.1-codex-mini',
    }),
  },
  {
    id: 'gpt-5.2',
    family: 'GPT-5.2',
    matchDisplay: 'GPT-5.2 and Codex / fast variants',
    cacheWriteMode: 'fallback',
    matches: (id) => /^gpt-5-2(?:-|$)/.test(id),
    buildRule: () => openAiRule('GPT-5.2', 1.75, 0.175, 14),
  },
  {
    id: 'gpt-5.3-codex',
    family: 'GPT-5.3-Codex',
    matchDisplay: 'GPT-5.3-Codex',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gpt-5-3-codex',
    buildRule: () => openAiRule('GPT-5.3-Codex', 1.75, 0.175, 14, {
      source: 'https://developers.openai.com/api/docs/models/gpt-5.3-codex',
    }),
  },
  {
    id: 'gpt-5.4-mini',
    family: 'GPT-5.4 mini',
    matchDisplay: 'GPT-5.4 mini',
    cacheWriteMode: 'fallback',
    matches: (id) => /^gpt-5-4-mini(?:-|$)/.test(id),
    buildRule: () => openAiRule('GPT-5.4 mini', 0.75, 0.075, 4.5),
  },
  {
    id: 'gpt-5.4',
    family: 'GPT-5.4',
    matchDisplay: 'GPT-5.4',
    cacheWriteMode: 'fallback',
    matches: (id) => /^gpt-5-4(?:-|$)/.test(id),
    buildRule: () => openAiRule('GPT-5.4', 2.5, 0.25, 15),
  },
  {
    id: 'gpt-5.5',
    family: 'GPT-5.5',
    matchDisplay: 'GPT-5.5',
    cacheWriteMode: 'fallback',
    matches: (id) => /^gpt-5-5(?:-|$)/.test(id),
    buildRule: () => openAiRule('GPT-5.5', 5, 0.5, 30),
  },
  {
    id: 'o3',
    family: 'o3',
    matchDisplay: 'o3 / o3-high',
    cacheWriteMode: 'fallback',
    matches: (id) => /^o3(?:-high)?$/.test(id),
    buildRule: () => openAiRule('o3', 2, 0.5, 8),
  },
  {
    id: 'o3-mini',
    family: 'o3-mini',
    matchDisplay: 'o3-mini',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'o3-mini',
    buildRule: () => openAiRule('o3-mini', 1.1, 0.55, 4.4, {
      source: 'https://developers.openai.com/api/docs/models/o3-mini',
    }),
  },
  {
    id: 'o3-pro',
    family: 'o3-pro',
    matchDisplay: 'o3-pro',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'o3-pro',
    buildRule: () => openAiRule('o3-pro', 20, 20, 80, {
      source: 'https://developers.openai.com/api/docs/models/o3-pro',
      catalogStatus: 'estimated',
      exactForStats: false,
    }),
    note: 'OpenAI publishes o3-pro input and output pricing, but the public model page does not list a discounted cached-input rate. This estimator bills cache hits at the standard input rate.',
  },
  {
    id: 'o4-mini',
    family: 'o4-mini',
    matchDisplay: 'o4-mini',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'o4-mini',
    buildRule: () => openAiRule('o4-mini', 1.1, 0.275, 4.4, {
      source: 'https://developers.openai.com/api/docs/models/o4-mini',
    }),
  },
  {
    id: 'gemini-2.5-pro',
    family: 'Gemini 2.5 Pro',
    matchDisplay: 'Gemini 2.5 Pro',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gemini-2-5-pro',
    buildRule: () => googleRule('Gemini 2.5 Pro', 1.25, 0.125, 10),
    catalogDisplayUsdPerM: {
      input: '$1.25 / $2.50',
      cacheRead: '$0.125 / $0.25',
      output: '$10.00 / $15.00',
    },
    note: 'Prompts above 200k tokens use the higher tier shown after the slash; cache storage-hour fees are not included in request totals.',
  },
  {
    id: 'gemini-2.5-flash',
    family: 'Gemini 2.5 Flash',
    matchDisplay: 'Gemini 2.5 Flash',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gemini-2-5-flash',
    buildRule: () => googleRule('Gemini 2.5 Flash', 0.3, 0.03, 2.5),
    note: 'Gemini context-cache storage-hour fees are not included in request totals.',
  },
  {
    id: 'gemini-3.0-pro',
    family: 'Gemini 3.0 Pro',
    matchDisplay: 'Gemini 3.0 Pro',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gemini-3-0-pro',
    buildRule: () => googleRule('Gemini 3.0 Pro', 2, 0.2, 12),
    note: 'Based on the standard 3.x Pro preview tier; context-cache storage-hour fees are not included in request totals.',
  },
  {
    id: 'gemini-3.0-flash-minimal',
    family: 'Gemini 3.0 Flash Minimal',
    matchDisplay: 'Gemini 3.0 Flash Minimal',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gemini-3-0-flash-minimal',
    buildRule: () => googleRule('Gemini 3.0 Flash Minimal', 0.25, 0.05, 1.5),
    note: 'Maps to the lower-cost Flash batch/flex tier; context-cache storage-hour fees are not included in request totals.',
  },
  {
    id: 'gemini-3.0-flash-low',
    family: 'Gemini 3.0 Flash Low',
    matchDisplay: 'Gemini 3.0 Flash Low',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gemini-3-0-flash-low',
    buildRule: () => googleRule('Gemini 3.0 Flash Low', 0.25, 0.05, 1.5),
    note: 'Maps to the lower-cost Flash batch/flex tier; context-cache storage-hour fees are not included in request totals.',
  },
  {
    id: 'gemini-3.0-flash',
    family: 'Gemini 3.0 Flash',
    matchDisplay: 'Gemini 3.0 Flash',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gemini-3-0-flash',
    buildRule: () => googleRule('Gemini 3.0 Flash', 0.5, 0.05, 3),
    note: 'Gemini context-cache storage-hour fees are not included in request totals.',
  },
  {
    id: 'gemini-3.0-flash-high',
    family: 'Gemini 3.0 Flash High',
    matchDisplay: 'Gemini 3.0 Flash High',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gemini-3-0-flash-high',
    buildRule: () => googleRule('Gemini 3.0 Flash High', 0.9, 0.09, 5.4),
    note: 'Maps to the priority Flash tier; context-cache storage-hour fees are not included in request totals.',
  },
  {
    id: 'gemini-3.1-pro-low',
    family: 'Gemini 3.1 Pro Low',
    matchDisplay: 'Gemini 3.1 Pro Low',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gemini-3-1-pro-low',
    buildRule: () => googleRule('Gemini 3.1 Pro Low', 1, 0.2, 6),
    note: 'Maps to the lower-cost Pro batch/flex tier; context-cache storage-hour fees are not included in request totals.',
  },
  {
    id: 'gemini-3.1-pro-high',
    family: 'Gemini 3.1 Pro High',
    matchDisplay: 'Gemini 3.1 Pro High',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'gemini-3-1-pro-high',
    buildRule: () => googleRule('Gemini 3.1 Pro High', 3.6, 0.36, 21.6, {
      catalogStatus: 'estimated',
      exactForStats: false,
    }),
    note: 'Estimated from the Gemini 3.1 Pro priority tier. Google bills context-cache reads separately and storage-hours are still excluded from dashboard request totals.',
  },
  {
    id: 'deepseek-v3',
    family: 'DeepSeek V3',
    matchDisplay: 'DeepSeek V3',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'deepseek-v3' || id === 'deepseek-v3-2',
    buildRule: () => deepSeekRule('DeepSeek V3', 0.27, 0.07, 1.1),
  },
  {
    id: 'deepseek-r1',
    family: 'DeepSeek R1',
    matchDisplay: 'DeepSeek R1',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'deepseek-r1',
    buildRule: () => deepSeekRule('DeepSeek R1', 0.55, 0.14, 2.19),
  },
  {
    id: 'kimi-k2',
    family: 'Kimi K2',
    matchDisplay: 'Kimi K2 / K2-thinking',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'kimi-k2' || id === 'kimi-k2-thinking',
    buildRule: () => kimiRule('Kimi K2', 4, 1, 16),
  },
  {
    id: 'kimi-k2.5',
    family: 'Kimi K2.5',
    matchDisplay: 'Kimi K2.5',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'kimi-k2-5',
    buildRule: () => kimiRule('Kimi K2.5', 4, 0.7, 21, {
      source: 'https://platform.kimi.com/docs/pricing/chat-k2-5',
    }),
  },
  {
    id: 'kimi-k2.6',
    family: 'Kimi K2.6',
    matchDisplay: 'Kimi K2.6',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'kimi-k2-6',
    buildRule: () => kimiRule('Kimi K2.6', 6.5, 1.1, 27, {
      source: 'https://platform.kimi.com/docs/pricing/chat-k26',
    }),
  },
  {
    id: 'minimax-m2.5',
    family: 'MiniMax M2.5',
    matchDisplay: 'MiniMax M2.5',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'minimax-m2-5' || id === 'm2-5' || id === 'm2-5-highspeed',
    buildRule: () => miniMaxRule('MiniMax M2.5', cnyToUsd(2.1), cnyToUsd(8.4), cnyToUsd(0.21), cnyToUsd(2.625)),
  },
  {
    id: 'adaptive',
    family: 'Adaptive',
    matchDisplay: 'Adaptive',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'adaptive',
    buildRule: () => exactRule({
      provider: 'windsurf',
      label: 'Adaptive',
      source: 'https://docs.windsurf.com/windsurf/adaptive',
      inputUsdPerM: 0.5,
      outputUsdPerM: 2,
      cacheReadUsdPerM: 0.1,
      cacheWriteFallbackUsdPerM: 0.5,
    }),
    note: 'Official Windsurf self-serve promotional rate through May 7, 2026.',
  },
  {
    id: 'swe-1.6',
    family: 'SWE-1.6',
    matchDisplay: 'SWE-1.6',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'swe-1-6',
    buildRule: () => exactRule({
      provider: 'windsurf',
      label: 'SWE-1.6',
      source: 'https://docs.windsurf.com/windsurf/models',
      inputUsdPerM: 0.3,
      outputUsdPerM: 1.5,
      cacheReadUsdPerM: 0.03,
      cacheWriteFallbackUsdPerM: 0.3,
      catalogStatus: 'estimated',
      exactForStats: false,
    }),
    note: 'Estimated from the current Windsurf model selector / docs search result for self-serve token pricing.',
  },
  {
    id: 'swe-1.6-fast',
    family: 'SWE-1.6 Fast',
    matchDisplay: 'SWE-1.6 Fast',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'swe-1-6-fast',
    buildRule: () => exactRule({
      provider: 'windsurf',
      label: 'SWE-1.6 Fast',
      source: 'https://docs.windsurf.com/windsurf/models',
      inputUsdPerM: 0.3,
      outputUsdPerM: 1.5,
      cacheReadUsdPerM: 0.03,
      cacheWriteFallbackUsdPerM: 0.3,
      catalogStatus: 'estimated',
      exactForStats: false,
    }),
    note: 'Estimated from the current Windsurf model selector / docs search result. Docs describe Fast as the same intelligence with speed-focused pricing/priority behavior.',
  },
  {
    id: 'swe-1.5',
    family: 'SWE-1.5',
    matchDisplay: 'SWE-1.5',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'swe-1-5',
    buildRule: () => exactRule({
      provider: 'windsurf',
      label: 'SWE-1.5',
      source: 'https://docs.windsurf.com/windsurf/accounts/quota',
      inputUsdPerM: 0,
      outputUsdPerM: 0,
      cacheReadUsdPerM: 0,
      cacheWriteFallbackUsdPerM: 0,
      catalogStatus: 'estimated',
      exactForStats: false,
    }),
    note: 'Estimated as a free self-serve model because Windsurf quota docs explicitly call out SWE-1.5 as a free model for routine tasks.',
  },
  {
    id: 'grok-3',
    family: 'Grok 3',
    matchDisplay: 'Grok 3',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'grok-3',
    buildRule: () => xAiRule('Grok 3', 3, 0.75, 15, {
      catalogStatus: 'estimated',
      exactForStats: false,
      source: 'https://docs.x.ai/developers/models?cluster=us-east-1%2F',
    }),
    note: 'Estimated from xAI’s published Grok 3 token pricing. Cached-input pricing is applied using the documented reduced cached-token rate.',
  },
  {
    id: 'grok-3-mini',
    family: 'Grok 3 Mini',
    matchDisplay: 'Grok 3 Mini / Mini Thinking',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'grok-3-mini' || id === 'grok-3-mini-thinking',
    buildRule: () => xAiRule('Grok 3 Mini', 0.3, 0.075, 0.5, {
      catalogStatus: 'estimated',
      exactForStats: false,
      source: 'https://docs.x.ai/developers/models?cluster=us-east-1%2F',
    }),
    note: 'Estimated from xAI’s published Grok 3 Mini token pricing. Thinking and non-thinking variants are billed the same here unless xAI publishes a separate rate.',
  },
  {
    id: 'grok-code-fast-1',
    family: 'Grok Code Fast 1',
    matchDisplay: 'Grok Code Fast 1',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'grok-code-fast-1',
    buildRule: () => xAiRule('Grok Code Fast 1', 0.2, 0.05, 1.5, {
      catalogStatus: 'estimated',
      exactForStats: false,
      source: 'https://docs.x.ai/developers/models?cluster=us-east-1%2F',
    }),
    note: 'Estimated from xAI’s published Grok Code Fast 1 input/output price and the same 25% cached-input ratio used by Grok 3 family models.',
  },
  {
    id: 'qwen-3',
    family: 'Qwen 3',
    matchDisplay: 'Qwen 3 alias',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'qwen-3',
    buildRule: () => alibabaRule('Qwen 3', 1.2, 0.24, 6, {
      catalogStatus: 'estimated',
      exactForStats: false,
      cacheWriteFallbackUsdPerM: 1.5,
    }),
    note: 'Estimated by mapping the broad local `qwen-3` alias to the public qwen3-max 0-32K international tier. Cache hits use Alibaba’s 20% implicit-cache rate; cache writes use the 125% explicit-cache create rate when creation tokens are reported.',
  },
  {
    id: 'glm-4.7',
    family: 'GLM 4.7',
    matchDisplay: 'GLM 4.7',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'glm-4-7' || id === 'glm-4-7-fast',
    buildRule: () => zhipuRule('GLM 4.7', 0.431, 2.007, {
      catalogStatus: 'estimated',
      exactForStats: false,
      cacheReadUsdPerM: 0.431,
    }),
    note: 'Estimated from the Alibaba Cloud Model Studio GLM 4.7 0-32K tier. `glm-4.7-fast` is treated the same because no separate public token rate was found.',
  },
  {
    id: 'glm-5',
    family: 'GLM 5',
    matchDisplay: 'GLM 5 / GLM 5.1',
    cacheWriteMode: 'fallback',
    matches: (id) => id === 'glm-5' || id === 'glm-5-1',
    buildRule: () => zhipuRule('GLM 5', 0.573, 2.58, {
      catalogStatus: 'estimated',
      exactForStats: false,
      cacheReadUsdPerM: 0.573 * 0.2,
    }),
    note: 'Estimated from the Alibaba Cloud Model Studio GLM 5 0-32K tier. `glm-5.1` is mapped to the same public baseline and cache hits use the documented 20% implicit-cache rate.',
  },
];

const REFERENCE_SPECS = [
  {
    matches: (id) => id === 'gpt-oss-120b',
    build: (model) => referenceCatalogEntry({
      id: model,
      provider: 'openai',
      family: model,
      matchDisplay: model,
      source: 'https://openai.com/api/pricing/',
      reason: 'no_public_token_price',
    }),
  },
  {
    matches: (id) => id === 'swe-1-5-fast',
    build: (model) => referenceCatalogEntry({
      id: model,
      provider: 'windsurf',
      family: model,
      matchDisplay: 'SWE-1.5 Fast',
      source: 'https://docs.windsurf.com/windsurf/accounts/quota',
      reason: 'no_public_token_price',
      note: 'Windsurf docs say priority and speed variants cost more, but no stable public per-token price was found for SWE-1.5 Fast.',
    }),
  },
  {
    matches: (id) => id === 'swe-1-5-thinking',
    build: (model) => referenceCatalogEntry({
      id: model,
      provider: 'windsurf',
      family: model,
      matchDisplay: 'SWE-1.5 Thinking',
      source: 'https://docs.windsurf.com/windsurf/models',
      reason: 'no_public_token_price',
      note: 'This Windsurf in-house variant appears in the local catalog, but no public self-serve token price was found in the current docs snapshot.',
    }),
  },
  {
    matches: (id) => id === 'arena-fast' || id === 'arena-smart',
    build: (model) => referenceCatalogEntry({
      id: model,
      provider: 'windsurf',
      family: model,
      matchDisplay: model === 'arena-fast' ? 'Arena Fast battle group' : 'Arena Smart battle group',
      source: 'https://docs.windsurf.com/windsurf/cascade/arena',
      displayUsdPerM: {
        input: '2 × selected model input rate',
        cacheRead: '2 × selected model cache rate',
        cacheWrite: '2 × selected model cache-write rate',
        output: '2 × selected model output rate',
      },
      note: 'Battle groups run two hidden models in parallel. Windsurf docs confirm total cost is double the displayed single-model group cost, but the exact underlying model mix varies by request.',
    }),
  },
];

function buildUnitsFromRule(rule) {
  if (!rule.available) return null;
  return {
    input: rule.inputUsdPerM,
    cacheRead: rule.cacheReadUsdPerM ?? rule.inputUsdPerM,
    cacheWrite5m: rule.cacheWrite5mUsdPerM ?? null,
    cacheWrite1h: rule.cacheWrite1hUsdPerM ?? null,
    cacheWriteFallback: rule.cacheWriteFallbackUsdPerM ?? rule.inputUsdPerM,
    output: rule.outputUsdPerM,
  };
}

function findExactSpec(id) {
  return EXACT_SPECS.find((spec) => spec.matches(id)) || null;
}

function findReferenceSpec(id) {
  return REFERENCE_SPECS.find((spec) => spec.matches(id)) || null;
}

function buildCatalogEntry(model) {
  const id = String(model || '').trim();
  const normalized = normalizeModelId(id);
  const fx = pricingFx();
  const exact = findExactSpec(normalized);
  if (exact) {
    const rule = exact.buildRule();
    const units = buildUnitsFromRule(rule);
    const catalogStatus = rule.catalogStatus || 'exact';
    return {
      id,
      provider: rule.provider || providerForModel(id),
      family: id,
      matchDisplay: exact.matchDisplay,
      available: true,
      exactForStats: rule.exactForStats !== false && catalogStatus === 'exact',
      catalogStatus,
      reason: '',
      source: rule.source || '',
      cacheWriteMode: exact.cacheWriteMode,
      unitUsdPerM: units,
      unitCnyPerM: convertUnitBlock(units, fx.usdToCny),
      displayUsdPerM: exact.catalogDisplayUsdPerM || null,
      note: exact.note || '',
    };
  }

  const reference = findReferenceSpec(normalized);
  if (reference) return reference.build(id);

  const provider = providerForModel(id);
  const source = provider === 'windsurf'
    ? 'https://docs.windsurf.com/windsurf/accounts/quota'
    : '';
  return referenceCatalogEntry({
    id,
    provider,
    family: id,
    matchDisplay: id,
    source,
    reason: provider === 'windsurf' ? 'no_public_token_price' : 'unsupported_model_family',
  });
}

function normalizeUsage(usage = {}) {
  return {
    promptTokens: Math.round(num(usage.promptTokens)),
    completionTokens: Math.round(num(usage.completionTokens)),
    cacheReadTokens: Math.round(num(usage.cacheReadTokens)),
    cacheWriteTokens: Math.round(num(usage.cacheWriteTokens)),
    cacheWrite5mTokens: Math.round(num(usage.cacheWrite5mTokens)),
    cacheWrite1hTokens: Math.round(num(usage.cacheWrite1hTokens)),
    localCachePromptTokens: Math.round(num(usage.localCachePromptTokens)),
    localCacheCompletionTokens: Math.round(num(usage.localCacheCompletionTokens)),
  };
}

export function getModelPricingRule(model) {
  const id = normalizeModelId(model);
  const spec = findExactSpec(id);
  if (spec) return spec.buildRule();

  const provider = providerForModel(model);
  if (provider === 'windsurf') {
    return unavailableRule(provider, 'no_public_token_price', 'https://docs.windsurf.com/windsurf/accounts/quota');
  }
  if (findReferenceSpec(id)) {
    const ref = findReferenceSpec(id).build(String(model || '').trim());
    return unavailableRule(ref.provider, ref.reason, ref.source || '');
  }
  return unavailableRule(provider, 'unsupported_model_family');
}

export function listModelPricingCatalog() {
  const fx = pricingFx();
  const entries = Object.keys(MODELS)
    .map((model) => buildCatalogEntry(model))
    .sort((a, b) => {
      const providerRank = PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider);
      if (providerRank !== 0) return providerRank;
      return a.id.localeCompare(b.id, 'en');
    });

  const exactModels = entries.filter((entry) => entry.catalogStatus === 'exact').length;
  const estimatedModels = entries.filter((entry) => entry.catalogStatus === 'estimated').length;
  const referenceModels = entries.filter((entry) => entry.catalogStatus === 'reference').length;
  const noPublicPriceModels = entries.filter((entry) => entry.catalogStatus === 'no_public_price').length;
  const unsupportedModels = entries.filter((entry) => entry.catalogStatus === 'unsupported').length;
  const sources = new Set(entries.map((entry) => entry.source).filter(Boolean));
  const providers = new Set(entries.map((entry) => entry.provider).filter(Boolean));

  return {
    pricingFx: fx,
    entries,
    summary: {
      totalModels: entries.length,
      exactModels,
      estimatedModels,
      referenceModels,
      noPublicPriceModels,
      unsupportedModels,
      pricedFamilies: exactModels + estimatedModels,
      referenceFamilies: referenceModels,
      unpricedFamilies: noPublicPriceModels + unsupportedModels,
      sourceCount: sources.size,
      providerCount: providers.size,
    },
  };
}

export function estimateModelSpend(model, usage = {}) {
  const rule = getModelPricingRule(model);
  const fx = pricingFx();
  const u = normalizeUsage(usage);
  const catalogStatus = rule.catalogStatus || 'exact';
  const exactForStats = rule.exactForStats !== false && catalogStatus === 'exact';

  if (!rule.available) {
    return {
      available: false,
      provider: rule.provider,
      reason: rule.reason,
      source: rule.source || '',
      catalogStatus: rule.catalogStatus || (rule.reason === 'no_public_token_price' ? 'no_public_price' : 'unsupported'),
      exactForStats: false,
      currency: { usdToCny: fx.usdToCny, date: fx.date, source: fx.source },
      chargeableTokens: {
        prompt: 0,
        freshInput: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
      },
      usd: {
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        total: 0,
      },
      cny: {
        total: 0,
      },
    };
  }

  const billablePrompt = Math.max(0, u.promptTokens - u.localCachePromptTokens);
  const billableOutput = Math.max(0, u.completionTokens - u.localCacheCompletionTokens);
  const billableCacheRead = Math.max(0, u.cacheReadTokens - u.localCachePromptTokens);
  const billableCacheWrite = Math.max(0, u.cacheWriteTokens);
  const freshInputTokens = Math.max(0, billablePrompt - billableCacheRead - billableCacheWrite);

  const cacheWrite5m = Math.min(billableCacheWrite, u.cacheWrite5mTokens);
  const cacheWrite1h = Math.min(Math.max(0, billableCacheWrite - cacheWrite5m), u.cacheWrite1hTokens);
  const cacheWriteRemainder = Math.max(0, billableCacheWrite - cacheWrite5m - cacheWrite1h);

  const inputUsd = (freshInputTokens / 1_000_000) * rule.inputUsdPerM;
  const cacheReadUsd = (billableCacheRead / 1_000_000) * (rule.cacheReadUsdPerM ?? rule.inputUsdPerM);
  const cacheWriteUsd =
    (cacheWrite5m / 1_000_000) * (rule.cacheWrite5mUsdPerM ?? rule.cacheWriteFallbackUsdPerM ?? rule.inputUsdPerM) +
    (cacheWrite1h / 1_000_000) * (rule.cacheWrite1hUsdPerM ?? rule.cacheWriteFallbackUsdPerM ?? rule.inputUsdPerM) +
    (cacheWriteRemainder / 1_000_000) * (rule.cacheWriteFallbackUsdPerM ?? rule.inputUsdPerM);
  const outputUsd = (billableOutput / 1_000_000) * rule.outputUsdPerM;
  const totalUsd = inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd;

  return {
    available: true,
    provider: rule.provider,
    label: rule.label,
    source: rule.source,
    catalogStatus,
    exactForStats,
    currency: { usdToCny: fx.usdToCny, date: fx.date, source: fx.source },
    unitUsdPerM: {
      input: rule.inputUsdPerM,
      cacheRead: rule.cacheReadUsdPerM ?? rule.inputUsdPerM,
      cacheWrite5m: rule.cacheWrite5mUsdPerM ?? rule.cacheWriteFallbackUsdPerM ?? rule.inputUsdPerM,
      cacheWrite1h: rule.cacheWrite1hUsdPerM ?? rule.cacheWriteFallbackUsdPerM ?? rule.inputUsdPerM,
      cacheWriteFallback: rule.cacheWriteFallbackUsdPerM ?? rule.inputUsdPerM,
      output: rule.outputUsdPerM,
    },
    chargeableTokens: {
      prompt: billablePrompt,
      freshInput: freshInputTokens,
      cacheRead: billableCacheRead,
      cacheWrite: billableCacheWrite,
      cacheWrite5m,
      cacheWrite1h,
      output: billableOutput,
    },
    localCacheTokens: {
      prompt: u.localCachePromptTokens,
      output: u.localCacheCompletionTokens,
    },
    usd: {
      input: roundMoney(inputUsd),
      cacheRead: roundMoney(cacheReadUsd),
      cacheWrite: roundMoney(cacheWriteUsd),
      output: roundMoney(outputUsd),
      total: roundMoney(totalUsd),
    },
    cny: {
      total: roundMoney(totalUsd * fx.usdToCny),
    },
  };
}

export function summarizeStatsSpend(stats = {}) {
  const fx = pricingFx();
  const modelCounts = {};
  const unpriced = [];
  const totals = {
    usd: 0,
    cny: 0,
    pricedModels: 0,
    officialModels: 0,
    estimatedModels: 0,
    totalModels: 0,
    pricedRequests: 0,
    officialRequests: 0,
    estimatedRequests: 0,
    pricedTokens: 0,
    unpricedRequests: 0,
    unpricedTokens: 0,
  };

  for (const [model, entry] of Object.entries(stats.modelCounts || {})) {
    totals.totalModels++;
    const pricing = estimateModelSpend(model, entry?.usage || {});
    modelCounts[model] = { ...entry, pricing };
    const requests = Number(entry?.requests || 0);
    const tokens = Number(entry?.usage?.totalTokens || 0);

    if (pricing.available) {
      totals.pricedModels++;
      totals.pricedRequests += requests;
      totals.pricedTokens += tokens;
      totals.usd += pricing.usd.total;
      totals.cny += pricing.cny.total;
      if (pricing.catalogStatus === 'estimated') {
        totals.estimatedModels++;
        totals.estimatedRequests += requests;
      } else {
        totals.officialModels++;
        totals.officialRequests += requests;
      }
    } else {
      totals.unpricedRequests += requests;
      totals.unpricedTokens += tokens;
      unpriced.push({
        model,
        provider: pricing.provider,
        reason: pricing.reason,
        source: pricing.source,
      });
    }
  }

  return {
    modelCounts,
    pricingFx: fx,
    pricingSummary: {
      totalUsd: roundMoney(totals.usd),
      totalCny: roundMoney(totals.cny),
      pricedModels: totals.pricedModels,
      officialModels: totals.officialModels,
      estimatedModels: totals.estimatedModels,
      totalModels: totals.totalModels,
      pricedRequests: totals.pricedRequests,
      officialRequests: totals.officialRequests,
      estimatedRequests: totals.estimatedRequests,
      pricedTokens: totals.pricedTokens,
      unpricedRequests: totals.unpricedRequests,
      unpricedTokens: totals.unpricedTokens,
      unpricedModels: unpriced,
    },
  };
}
