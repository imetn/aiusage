import type { CostStatus, IngestBreakdown } from '@aiusage/shared';
import { calculateIngestBreakdownCost } from './pricing.js';

/**
 * A daily_usage_breakdown row as stored in D1. Rows whose cost_status is
 * `unavailable` were priced before the catalog knew their model. The CLI can
 * only re-upload days whose local logs still exist, so rows from deleted
 * sessions would keep a $0 cost forever unless they are repriced here from
 * their stored token counts.
 */
export interface StoredBreakdownRow {
  device_id: string;
  usage_date: string;
  provider: string;
  product: string;
  channel: string;
  model: string;
  project: string;
  event_count: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  extra_metrics_json: string | null;
}

export interface RepricedRow {
  row: StoredBreakdownRow;
  estimatedCostUsd: number;
  costStatus: CostStatus;
  pricingVersion: string;
}

function cacheWriteSplit(row: StoredBreakdownRow): { cacheWrite5mTokens?: number; cacheWrite1hTokens?: number } {
  try {
    const extra = JSON.parse(row.extra_metrics_json ?? '{}') as Record<string, unknown>;
    return {
      cacheWrite5mTokens: typeof extra.cache_write_5m_tokens === 'number' ? extra.cache_write_5m_tokens : undefined,
      cacheWrite1hTokens: typeof extra.cache_write_1h_tokens === 'number' ? extra.cache_write_1h_tokens : undefined,
    };
  } catch {
    return {};
  }
}

/** Prices a stored row with the bundled catalog; null when it is still unpriced. */
export function repriceRow(row: StoredBreakdownRow): RepricedRow | null {
  const breakdown: IngestBreakdown = {
    provider: row.provider as IngestBreakdown['provider'],
    product: row.product as IngestBreakdown['product'],
    channel: row.channel as IngestBreakdown['channel'],
    model: row.model,
    project: row.project,
    eventCount: row.event_count,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    ...cacheWriteSplit(row),
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
  };
  const cost = calculateIngestBreakdownCost(breakdown);
  if (cost.costStatus === 'unavailable') return null;
  return {
    row,
    estimatedCostUsd: Math.round(cost.estimatedCostUsd * 10000) / 10000,
    costStatus: cost.costStatus,
    pricingVersion: cost.pricingVersion,
  };
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Builds literal SQL for `wrangler d1 execute --file`. Updates only rows that
 * are still unavailable, then refreshes the top project/model of touched days.
 */
export function buildRepriceSql(repriced: RepricedRow[], now: string): string {
  const statements = repriced.map(({ row, estimatedCostUsd, costStatus, pricingVersion }) => `UPDATE daily_usage_breakdown
SET estimated_cost_usd = ${estimatedCostUsd}, cost_status = ${sqlString(costStatus)},
    pricing_version = ${sqlString(pricingVersion)}, updated_at = ${sqlString(now)}
WHERE device_id = ${sqlString(row.device_id)} AND usage_date = ${sqlString(row.usage_date)}
  AND provider = ${sqlString(row.provider)} AND product = ${sqlString(row.product)}
  AND channel = ${sqlString(row.channel)} AND model = ${sqlString(row.model)}
  AND project = ${sqlString(row.project)} AND cost_status = 'unavailable';`);

  const days = [...new Set(repriced.map(({ row }) => `${row.device_id}\u0000${row.usage_date}`))];
  for (const day of days) {
    const [deviceId, usageDate] = day.split('\u0000');
    const where = `b.device_id = ${sqlString(deviceId)} AND b.usage_date = ${sqlString(usageDate)}`;
    statements.push(`UPDATE daily_usage
SET top_project_by_cost = COALESCE((SELECT COALESCE(b.project_alias, b.project_display) FROM daily_usage_breakdown b
      WHERE ${where} GROUP BY COALESCE(b.project_alias, b.project_display) ORDER BY SUM(b.estimated_cost_usd) DESC LIMIT 1), 'unknown'),
    top_project_cost_usd = COALESCE((SELECT SUM(b.estimated_cost_usd) AS c FROM daily_usage_breakdown b
      WHERE ${where} GROUP BY COALESCE(b.project_alias, b.project_display) ORDER BY c DESC LIMIT 1), 0),
    top_model_by_cost = COALESCE((SELECT b.model FROM daily_usage_breakdown b
      WHERE ${where} GROUP BY b.model ORDER BY SUM(b.estimated_cost_usd) DESC LIMIT 1), 'unknown'),
    top_model_cost_usd = COALESCE((SELECT SUM(b.estimated_cost_usd) AS c FROM daily_usage_breakdown b
      WHERE ${where} GROUP BY b.model ORDER BY c DESC LIMIT 1), 0)
WHERE device_id = ${sqlString(deviceId)} AND usage_date = ${sqlString(usageDate)};`);
  }
  return `${statements.join('\n')}\n`;
}
