/**
 * Worker 侧定价入口 —— 转发到 @aiusage/shared 的统一定价目录。
 * 历史 ModelPricing / PricingCatalog 类型保留 re-export 以兼容现有调用。
 */
import { calculateCost as calculateSharedCost } from '@aiusage/shared';
import type { CostCalcResult, IngestBreakdown } from '@aiusage/shared';

export function calculateIngestBreakdownCost(
  breakdown: IngestBreakdown,
  usageDate?: string,
  clientVersion?: string,
): CostCalcResult {
  // CLI 1.7.12 separated Codex reasoning from outputTokens in its uploads.
  const [, major, minor, patch] = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(clientVersion ?? '') ?? [];
  const separatesReasoning = Number(major) > 1
    || (Number(major) === 1 && (Number(minor) > 7 || (Number(minor) === 7 && Number(patch) >= 12)));
  const reasoning = (breakdown.product === 'codex' && separatesReasoning) || breakdown.product === 'antigravity'
    ? (breakdown.reasoningOutputTokens ?? 0) : 0;
  const calculated = calculateSharedCost(
    breakdown.provider,
    breakdown.product,
    breakdown.model,
    {
      inputTokens: breakdown.inputTokens,
      cachedInputTokens: breakdown.cachedInputTokens,
      cacheWriteTokens: breakdown.cacheWriteTokens,
      cacheWrite5mTokens: breakdown.cacheWrite5mTokens ?? breakdown.cacheWriteTokens,
      cacheWrite1hTokens: breakdown.cacheWrite1hTokens ?? 0,
      outputTokens: breakdown.outputTokens + reasoning,
    },
    { requestCount: breakdown.eventCount, usageTime: usageDate },
  );

  const hasVendorReportedCost = breakdown.product === 'trae-intl' || breakdown.product === 'opencode';
  if (
    breakdown.costUSD == null ||
    !Number.isFinite(breakdown.costUSD) ||
    breakdown.costUSD <= 0 ||
    (!hasVendorReportedCost && breakdown.pricingVersion !== calculated.pricingVersion)
  ) {
    return calculated;
  }

  return { ...calculated, estimatedCostUsd: breakdown.costUSD, costStatus: breakdown.product === 'antigravity' ? 'estimated' : 'exact' };
}

export {
  calculateCost,
  getWorstCostStatus,
  getPricingCatalog,
  catalog,
  PRICING_VERSION,
} from '@aiusage/shared';

export type {
  ModelPricing,
  PricingCatalog,
  ProductPricing,
  Currency,
  PricingTier,
  CostCalcInput,
  CostCalcResult,
} from '@aiusage/shared';
