import { describe, expect, it } from 'vitest';
import { calculateCost } from '@aiusage/shared';
import { buildRepriceSql, repriceRow, type StoredBreakdownRow } from './reprice';

const row: StoredBreakdownRow = {
  device_id: 'mac',
  usage_date: '2026-09-20',
  provider: 'openai',
  product: 'codex',
  channel: 'cli',
  model: 'gpt-6-astra',
  project: "/Users/me/o'brien",
  event_count: 28,
  input_tokens: 100_000,
  cached_input_tokens: 4_000_000,
  cache_write_tokens: 0,
  output_tokens: 20_000,
  reasoning_output_tokens: 5_000,
  extra_metrics_json: '{"cache_write_5m_tokens":0,"cache_write_1h_tokens":0}',
};

describe('repriceRow', () => {
  it('prices a stored row with the bundled catalog', () => {
    const repriced = repriceRow(row)!;
    const expected = calculateCost('openai', 'codex', 'gpt-6-astra', {
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      cacheWriteTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: row.output_tokens,
    }, { requestCount: row.event_count });

    expect(repriced.costStatus).not.toBe('unavailable');
    expect(repriced.estimatedCostUsd).toBeCloseTo(expected.estimatedCostUsd, 4);
    expect(repriced.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('uses the stored Anthropic cache write split', () => {
    const anthropic = {
      ...row,
      provider: 'anthropic',
      product: 'claude-code',
      model: 'claude-opus-5-5',
      cache_write_tokens: 1_000_000,
    };
    const fiveMinute = repriceRow({ ...anthropic, extra_metrics_json: '{"cache_write_5m_tokens":1000000,"cache_write_1h_tokens":0}' })!;
    const oneHour = repriceRow({ ...anthropic, extra_metrics_json: '{"cache_write_5m_tokens":0,"cache_write_1h_tokens":1000000}' })!;
    expect(oneHour.estimatedCostUsd).toBeGreaterThan(fiveMinute.estimatedCostUsd);
  });

  it('returns null for models the catalog still cannot price', () => {
    expect(repriceRow({ ...row, model: 'jev-router' })).toBeNull();
  });
});

describe('buildRepriceSql', () => {
  it('updates only still-unavailable rows and escapes literals', () => {
    const sql = buildRepriceSql([repriceRow(row)!], '2026-09-25T18:00:00.000Z');
    expect(sql).toContain("project = '/Users/me/o''brien'");
    expect(sql).toContain("AND cost_status = 'unavailable';");
    expect(sql.match(/UPDATE daily_usage\n/g)).toHaveLength(1);
  });
});
