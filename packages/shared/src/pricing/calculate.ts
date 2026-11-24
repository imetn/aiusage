import type { CostStatus } from '../types.js';
import type {
  PricingCatalog,
  ModelPricing,
  PricingTier,
  CostCalcInput,
  CostCalcResult,
} from './types.js';
import { catalog as defaultCatalog } from './catalog.js';
import { inferProviderFromModel, isRoutingProvider, normalizeRoutedModel } from './routing.js';

const REFERENCE_PRODUCTS: Record<string, string> = {
  anthropic: 'claude-code',
  openai: 'codex',
  google: 'gemini-cli',
  xai: 'opencode',
  deepseek: 'deepseek-chat',
  zhipu: 'glm-chat',
  moonshot: 'kimi-code',
  alibaba: 'qwen-code',
};

/**
 * Fast 模式按 Anthropic 官方公布的独立价格折算。
 * Opus 4.7 曾经是 6x，现已不可用；保留倍率只为历史日志重算。
 * Opus 4.6 fast 已按标准价计费，因此不再放大。
 * xAI Grok 4.7 Fast 为标准价 2x（长上下文档官方为 1.5x，此处按 2x 保守估算）。
 * OpenAI Codex 的 fast/priority 倍率另按官方 Codex speed/API priority 口径处理。
 */
const FAST_MULTIPLIERS: Record<string, number> = {
  'claude-fable-5-2': 2,
  'claude-opus-5-5': 2,
  'claude-opus-5': 2,
  'claude-opus-4-8': 2,
  'claude-opus-4-7': 6,
  'grok-4.7': 2,
};

type ServiceTierSuffix = 'fast' | 'priority' | 'ultrafast' | 'batch' | null;

const GPT_6_2_ULTRAFAST_PROMOTION_END = Date.parse('2027-03-01T00:00:00-08:00');

const OPENAI_CODEX_TIER_MULTIPLIERS: Record<string, number> = {
  'gpt-6.2-astra': 2,
  'gpt-6.2-sol': 2,
  'gpt-6.1-sol': 2,
  'gpt-6.1-terra': 2,
  'gpt-6-astra': 2,
  'gpt-6-sol': 2,
  'gpt-6-luna': 2,
  'gpt-5.6-sol': 2,
  'gpt-5.6-terra': 2,
  'gpt-5.6-luna': 2,
  'gpt-5.5': 2.5,
  'gpt-5.4': 2,
};

function splitServiceTierSuffix(model: string): { baseModel: string; tier: ServiceTierSuffix } {
  const gpt62 = /^(gpt-6\.2-(?:astra|sol))-(ultrafast|batch)$/.exec(model);
  if (gpt62) {
    return { baseModel: gpt62[1], tier: gpt62[2] === 'ultrafast' ? 'ultrafast' : 'batch' };
  }
  if (model === 'gpt-6.1-sol-ultrafast') {
    return { baseModel: model.replace(/-ultrafast$/, ''), tier: 'ultrafast' };
  }
  if (model.endsWith('-priority')) {
    return { baseModel: model.replace(/-priority$/, ''), tier: 'priority' };
  }
  if (model.endsWith('-fast')) {
    return { baseModel: model.replace(/-fast$/, ''), tier: 'fast' };
  }
  return { baseModel: model, tier: null };
}

function getServiceTierMultiplier(
  provider: string,
  product: string,
  resolvedModel: string,
  tier: ServiceTierSuffix,
): number {
  if (!tier) return 1;

  if (provider === 'openai' && product === 'codex') {
    // GPT-6.2 Ultrafast's date-dependent price is handled below.
    if (tier === 'ultrafast') return 6;
    if (tier === 'batch') return 0.5;
    if (tier === 'fast' && resolvedModel.startsWith('gpt-5.6-')) return 1;
    return OPENAI_CODEX_TIER_MULTIPLIERS[resolvedModel] ?? 1;
  }

  if (tier === 'fast') {
    return FAST_MULTIPLIERS[resolvedModel] ?? 1;
  }

  return 1;
}

/**
 * resolveModelPricing — alias 精确匹配，再 longest-prefix fallback。
 *
 * 跨档防护：当 model 仅在前缀后多一段"纯数字版本号"（如 `claude-opus-4-7` vs known
 * `claude-opus-4`）时，说明这是一个独立的新版本而非同 family 衍生，拒绝 fallback。
 * 这样可确保未来出现 `claude-opus-4-8` 等新版本被显式登记前，会返回 unavailable
 * 而不是默默按旧版本计算（旧版本可能贵 3 倍）。
 */
function resolveModelPricing(
  catalog: PricingCatalog,
  provider: string,
  product: string,
  model: string,
): { resolvedModel: string; pricing: ModelPricing; normalized: boolean } | null {
  const models = catalog.providers[provider]?.[product]?.models;
  if (!models) return null;

  const aliasResolved = catalog.aliases[model];
  if (aliasResolved && models[aliasResolved]) {
    // Alias 是 catalog 显式声明的等价名（如 claude-opus-4-7-20260201 → claude-opus-4-7），
    // 视为 exact 命中；只有前缀回退（fallback）才算 estimated
    return { resolvedModel: aliasResolved, pricing: models[aliasResolved], normalized: false };
  }

  if (models[model]) {
    return { resolvedModel: model, pricing: models[model], normalized: false };
  }

  // longest-prefix fallback（同 family / 同档位前缀）
  for (const knownModel of Object.keys(models).sort((a, b) => b.length - a.length)) {
    if (!model.startsWith(`${knownModel}-`)) continue;

    // 跨档防护：剥掉 known 前缀后，若 suffix 仅是版本号数字段（如 `-7`、`-7-20260201`），
    // 视为独立新版本，拒绝回退。这是为了避免 `claude-opus-4-7` 被错误归到旧 `claude-opus-4`。
    const suffix = model.slice(knownModel.length + 1); // 去掉 "knownModel-"
    if (/^\d+(?:[-.]\d+)*(?:-\d{6,8})?$/.test(suffix)) continue;

    return { resolvedModel: knownModel, pricing: models[knownModel], normalized: true };
  }

  return null;
}

/** 选阶梯：按总 input（含 cached + cache_write）命中。 */
function selectTier(tiers: PricingTier[], totalInputTokens: number): { tier: PricingTier; index: number } {
  for (let i = 0; i < tiers.length; i += 1) {
    const t = tiers[i];
    if (t.threshold === undefined || totalInputTokens <= t.threshold) {
      return { tier: t, index: i };
    }
  }
  return { tier: tiers[tiers.length - 1], index: tiers.length - 1 };
}

/** 折算成 USD。 */
function toUsd(amount: number, currency: ModelPricing['currency'], catalog: PricingCatalog): number {
  if (currency === 'USD') return amount;
  const rate = catalog.fx[currency];
  return rate ? amount / rate : amount;
}

export interface CalculateCostOptions {
  /** 自定义 catalog，便于 Worker 用 env 覆盖汇率等参数。 */
  catalog?: PricingCatalog;
  /** 聚合 breakdown 包含的请求/事件数；用于按平均单请求 input 估算阶梯。 */
  requestCount?: number;
  /** Unix milliseconds for a request, or the device-local YYYY-MM-DD for a daily aggregate. */
  usageTime?: number | string;
}

function resolveAntigravityRateModel(model: string): string {
  const lower = model.trim().toLowerCase();
  if (/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(lower)) return 'gemini-3.5-flash';
  if (lower === 'gemini-pro-orchestrator-neon') return 'gemini-4-neon';
  if (lower === 'gemini-pro-orchestrator-g1-pro') return 'gemini-4-argon';
  const base = lower.replace(/-(?:none|extra-low|low|medium|high|xhigh|max|tiered|control|thinking|agent|orchestrator)$/, '');
  if (base === 'gemini-3-flash') return 'gemini-3-flash-preview';
  return base;
}

export function calculateCost(
  provider: string,
  product: string,
  model: string,
  tokens: CostCalcInput,
  options: CalculateCostOptions = {},
): CostCalcResult {
  const cat = options.catalog ?? defaultCatalog;

  const totalTokens =
    tokens.inputTokens +
    tokens.cachedInputTokens +
    tokens.cacheWriteTokens +
    tokens.outputTokens;

  if (totalTokens === 0) {
    return { estimatedCostUsd: 0, costStatus: 'exact', pricingVersion: cat.version };
  }

  const antigravity = product === 'antigravity';
  const routed = normalizeRoutedModel(model);
  const normalizedModel = routed.model;
  const pricedModel = antigravity ? resolveAntigravityRateModel(normalizedModel) : normalizedModel;
  const pricedProvider = routed.stripped || isRoutingProvider(provider)
    ? inferProviderFromModel(pricedModel, provider)
    : provider;
  const pricedProduct = antigravity
    ? (REFERENCE_PRODUCTS[pricedProvider] ?? product)
    : !cat.providers[pricedProvider]?.[product] && product === 'claude-code'
      ? (REFERENCE_PRODUCTS[pricedProvider] ?? product)
      : product;
  const { baseModel, tier } = splitServiceTierSuffix(pricedModel);

  const resolved = resolveModelPricing(cat, pricedProvider, pricedProduct, baseModel);
  if (!resolved) {
    return { estimatedCostUsd: 0, costStatus: 'unavailable', pricingVersion: cat.version };
  }

  const { resolvedModel, normalized } = resolved;
  let pricing = resolved.pricing;
  let costStatus: CostStatus = normalized || antigravity ? 'estimated' : 'exact';
  if (pricing.price_changes?.length) {
    const { usageTime } = options;
    const usageDate = typeof usageTime === 'string' ? usageTime : new Date(usageTime ?? Date.now()).toISOString().slice(0, 10);
    for (const change of pricing.price_changes) {
      if (change.effective_from <= usageDate) pricing = { ...pricing, ...change };
    }
    if (usageTime === undefined || (typeof usageTime === 'string' && pricing.price_changes!.some(change => {
      const previousDay = new Date(`${change.effective_from}T00:00:00Z`);
      previousDay.setUTCDate(previousDay.getUTCDate() - 1);
      return usageDate === change.effective_from || usageDate === previousDay.toISOString().slice(0, 10);
    }))) costStatus = 'estimated';
  }

  // 阶梯：按总 input（含 cached/cw）命中档位
  let unit: PricingTier;
  let matchedTierIndex: number | undefined;
  if (pricing.tiers && pricing.tiers.length > 0) {
    const totalIn = tokens.inputTokens + tokens.cachedInputTokens + tokens.cacheWriteTokens;
    const requestCount = Math.max(1, Math.floor(options.requestCount ?? 1));
    const tierInput = totalIn / requestCount;
    const { tier, index } = selectTier(pricing.tiers, tierInput);
    unit = tier;
    matchedTierIndex = index;
    if (requestCount > 1) costStatus = 'estimated';
  } else {
    unit = {
      input_per_million: pricing.input_per_million ?? 0,
      output_per_million: pricing.output_per_million ?? 0,
      cached_input_per_million: pricing.cached_input_per_million ?? null,
      cache_write_per_million: pricing.cache_write_per_million,
      cache_write_5m_per_million: pricing.cache_write_5m_per_million ?? 0,
      cache_write_1h_per_million: pricing.cache_write_1h_per_million ?? 0,
    };
  }

  // cache_write_5m/1h 在阶梯档位里如果没填，回退到顶层
  const cw5Rate = unit.cache_write_5m_per_million ?? pricing.cache_write_5m_per_million ?? 0;
  const cw1hRate = unit.cache_write_1h_per_million ?? pricing.cache_write_1h_per_million ?? 0;
  const hasGenericCacheWriteRate =
    unit.cache_write_per_million !== undefined || pricing.cache_write_per_million !== undefined;
  const genericCwRate = unit.cache_write_per_million ?? pricing.cache_write_per_million ?? 0;
  const cachedRate = unit.cached_input_per_million ?? pricing.cached_input_per_million ?? 0;
  const cacheWriteCost = hasGenericCacheWriteRate
    ? (tokens.cacheWriteTokens / 1_000_000) * genericCwRate
    : ((tokens.cacheWrite5mTokens ?? tokens.cacheWriteTokens) / 1_000_000) * cw5Rate +
      ((tokens.cacheWrite1hTokens ?? 0) / 1_000_000) * cw1hRate;

  let raw =
    (tokens.inputTokens / 1_000_000) * (unit.input_per_million ?? 0) +
    (tokens.cachedInputTokens / 1_000_000) * (cachedRate ?? 0) +
    cacheWriteCost +
    (tokens.outputTokens / 1_000_000) * (unit.output_per_million ?? 0);

  // 折算 currency → USD
  raw = toUsd(raw, pricing.currency, cat);

  let multiplier = getServiceTierMultiplier(pricedProvider, pricedProduct, resolvedModel, tier);
  if (pricedProvider === 'openai' && pricedProduct === 'codex' && tier === 'ultrafast'
      && (resolvedModel === 'gpt-6.2-astra' || resolvedModel === 'gpt-6.2-sol')) {
    const { usageTime } = options;
    if (typeof usageTime === 'string') {
      multiplier = usageTime < '2027-03-01' ? 3 : 6;
      // The device's local day can straddle the Pacific cutover on either date.
      if (usageTime === '2027-02-28' || usageTime === '2027-03-01') costStatus = 'estimated';
    } else {
      multiplier = (usageTime ?? Date.now()) < GPT_6_2_ULTRAFAST_PROMOTION_END ? 3 : 6;
      if (usageTime === undefined) costStatus = 'estimated';
    }
  }
  const finalCost = raw * multiplier;

  return {
    estimatedCostUsd: Math.round(finalCost * 10000) / 10000,
    costStatus,
    pricingVersion: cat.version,
    resolvedModel,
    matchedTierIndex,
  };
}

export function getWorstCostStatus(statuses: CostStatus[]): CostStatus {
  if (statuses.includes('unavailable')) return 'unavailable';
  if (statuses.includes('estimated')) return 'estimated';
  return 'exact';
}
