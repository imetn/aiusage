import type { CostStatus } from '../types.js';

/** 定价币种。Worker 端在 calculateCost 里统一折算成 USD。 */
export type Currency = 'USD' | 'CNY';

/**
 * 阶梯定价：按 input token 数命中不同档位。
 * - threshold: 该档生效的 input token 上限（包含）；最后一档可不写表示 +∞
 * - 各 *_per_million 字段同 ModelPricing 的对应字段
 *
 * 示例 Qwen3-coder-plus：
 *   [{ threshold: 32_000, input: 4, output: 16 },
 *    { threshold: 128_000, input: 6, output: 24 },
 *    { threshold: 256_000, input: 10, output: 40 },
 *    { input: 20, output: 200 }]
 */
export interface PricingTier {
  /** 该档生效的 input token 数上限（包含）。省略表示 +∞，最后一档使用。 */
  threshold?: number;
  input_per_million: number;
  output_per_million: number;
  cached_input_per_million?: number | null;
  cache_write_per_million?: number;
  cache_write_5m_per_million?: number;
  cache_write_1h_per_million?: number;
}

/**
 * 单模型定价。
 * - 非阶梯模型：直接填顶层字段，tiers 留空
 * - 阶梯模型：tiers 非空时优先按 input token 命中档位；顶层字段作为兜底（非分档维度沿用）
 */
export interface ModelPricing {
  currency: Currency;
  /** 该价格生效起始日（ISO date，YYYY-MM-DD）；用于审计 */
  effective_from?: string;
  /** 该价格失效日；填了表示已废弃 */
  effective_to?: string;
  /** 备注（如：促销、即将下线、需要 batch 模式等） */
  notes?: string;

  // 非阶梯字段（无 tiers 时使用；有 tiers 时作为缓存/cache_write 兜底）
  input_per_million?: number;
  output_per_million?: number;
  cached_input_per_million?: number | null;
  /** 不区分缓存时长的通用 cache write 价格（如 OpenAI GPT-5.6） */
  cache_write_per_million?: number;
  cache_write_5m_per_million?: number;
  cache_write_1h_per_million?: number;

  /** 阶梯定价（按 input token 数）。非空时覆盖顶层 input/output。 */
  tiers?: PricingTier[];
  /** 按调用日期生效的后续单价，按日期升序。保留基础价格以重算历史促销。 */
  price_changes?: Array<PricingTier & { effective_from: string }>;
}

/** 一个 provider/product 下的模型集合。 */
export interface ProductPricing {
  models: Record<string, ModelPricing>;
}

export interface PricingCatalog {
  version: string;
  /** CNY → USD 折算率（1 USD = N CNY）。统一写在 catalog 上，避免漂移。 */
  fx: Record<Exclude<Currency, 'USD'>, number>;
  /** 模型别名映射（旧名 → 标准名）。resolveModel 时先经过 alias。 */
  aliases: Record<string, string>;
  /** provider → product → models。 */
  providers: Record<string, Record<string, ProductPricing>>;
}

// ── 计算输入/输出 ──

export interface CostCalcInput {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  outputTokens: number;
}

export interface CostCalcResult {
  estimatedCostUsd: number;
  costStatus: CostStatus;
  pricingVersion: string;
  /** 实际命中的模型 key（经过 alias / prefix fallback 后） */
  resolvedModel?: string;
  /** 阶梯模型命中的档位索引 */
  matchedTierIndex?: number;
}
