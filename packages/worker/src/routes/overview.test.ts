import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { OverviewResponse } from '@aiusage/shared';
import { buildDateWindow, buildWhere, handleOverview, parseFilters } from './overview';
import { handleBreakdowns } from './breakdowns.js';
import type { Env } from '../types.js';

type BreakdownResponse = {
  pagination: { total: number };
  data: Array<{ model: string; provider: string; estimated_cost_usd: number }>;
};

describe('overview filters', () => {
  it('builds inclusive date windows that include today without adding an extra day', () => {
    const now = new Date('2026-07-20T10:00:00.000Z');

    expect(buildDateWindow('7d', now)).toEqual({
      minDate: '2026-07-14',
      maxDate: '2026-07-20',
      days: 7,
    });
    expect(buildDateWindow('30d', now)).toEqual({
      minDate: '2026-06-21',
      maxDate: '2026-07-20',
      days: 30,
    });
    expect(buildDateWindow('month', now)).toEqual({
      minDate: '2026-07-01',
      maxDate: '2026-07-20',
      days: 20,
    });
  });

  it('parses repeated and comma-separated facet params as multi-select values', () => {
    const filters = parseFilters(new URL('https://example.com/api/v1/public/overview?range=30d&product=codex&product=claude-code&model=gpt-5,claude-opus'));

    expect(filters?.product).toEqual(['codex', 'claude-code']);
    expect(filters?.model).toEqual(['gpt-5', 'claude-opus']);
  });

  it('builds IN clauses for multi-selected facets', () => {
    const filters = parseFilters(new URL('https://example.com/api/v1/public/overview?range=7d&deviceId=mac-a&deviceId=mac-b&project=AIUsage'))!;
    const where = buildWhere(filters);

    expect(where.whereClause).toContain('b.device_id IN (?, ?)');
    expect(where.whereClause).toContain('COALESCE(b.project_alias, b.project_display) = ?');
    expect(where.params).toEqual([expect.any(String), expect.any(String), 'mac-a', 'mac-b', 'AIUsage']);
  });
});

describe('model reporting groups', () => {
  it('merges routing aliases in shares, facets and flows while keeping raw breakdown rows and costs', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const migration of ['0001_init.sql', '0002_project_fields.sql', '0004_daily_activity.sql']) {
        db.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
      }
      db.exec(`
        INSERT INTO devices (device_id, public_label, timezone, first_seen_at, last_seen_at)
        VALUES ('mac', 'Mac', 'UTC', '2026-11-18', '2026-11-18');
        INSERT INTO daily_usage (device_id, usage_date, created_at, updated_at)
        VALUES ('mac', '2026-11-18', '2026-11-18', '2026-11-18');
      `);
      const insert = db.prepare(`
        INSERT INTO daily_usage_breakdown
          (device_id, usage_date, provider, product, model, project, project_display,
           estimated_cost_usd, event_count, input_tokens, created_at, updated_at)
        VALUES ('mac', '2026-11-18', ?, ?, ?, 'test', 'Test', ?, ?, ?, '2026-11-18', '2026-11-18')
      `);
      const records = [
        ['anthropic', 'claude-code', 'claude-opus-5-5', 4, 1, 100],
        ['factory', 'claude-code', 'factory/claude-opus-5-5', 2, 2, 200],
        ['group', 'claude-code', 'group/auto-claude-opus-5-5', 0, 3, 300],
        ['factory', 'claude-code', 'factory/claude-opus-5.5-fast', 0, 1, 100],
        ['group', 'claude-code', 'group/auto-claude-opus-5-5-fast:high', 0, 1, 100],
        ['anthropic', 'claude-code', 'claude-fable-5-2', 2, 1, 100],
        ['factory', 'claude-code', 'factory/claude-fable-5.2', 0, 2, 200],
        ['group', 'claude-code', 'group/auto-claude-fable-5-2:high', 0, 3, 300],
        ['anthropic', 'claude-code', 'claude-sonnet-5.5', 1, 1, 100],
        ['group', 'claude-code', 'group/auto-claude-sonnet-5-5:medium', 0, 2, 200],
        ['factory', 'claude-code', 'factory/deepseek-v4.1-flash-1017', 0, 2, 200],
        ['auto', 'claude-code', 'auto/deepseek-v4.1-flash', 0, 1, 100],
        ['group', 'claude-code', 'group/auto-deepseek-v4-1-flash', 0, 3, 300],
        ['xai', 'claude-code', 'grok/grok-4.7', 1, 1, 100],
        ['group', 'claude-code', 'group/auto-grok-4-7', 0, 1, 100],
        ['xai', 'claude-code', 'grok-4-fast', 0, 1, 100],
        ['openai', 'codex', 'gpt-6-astra', 2, 1, 100],
        ['openai', 'codex', 'gpt-6-astra-priority', 4, 2, 200],
        ['openai', 'codex', 'codex-auto-review', 1, 1, 100],
        ['group', 'claude-code', 'group/auto-unknown', 0, 1, 100],
        ['auto', 'claude-code', 'model_api/experimental_0812', 0, 1, 100],
      ] as const;
      for (const row of records) insert.run(...row);
      const env = {
        PUBLIC_PROJECT_VISIBILITY: 'plain',
        DB: {
          prepare(sql: string) {
            const stmt = db.prepare(sql);
            return { bind: (...params: SQLInputValue[]) => ({
              first: async () => stmt.get(...params),
              all: async () => ({ results: stmt.all(...params) }),
            }) };
          },
        },
      } as unknown as Env;
      const request = (route: string, query = '') => new URL(`https://example.test/${route}?range=all${query}`);

      const overview = await (await handleOverview(request('overview'), env)).json<OverviewResponse>();
      expect(overview.totalEvents).toBe(records.reduce((sum, row) => sum + row[4], 0));
      expect(overview.totalCostUsd).toBe(records.reduce((sum, row) => sum + row[3], 0));
      expect(overview.modelCostShare.map(row => row.value)).toEqual([
        'claude-opus-5-5', 'gpt-6-astra', 'claude-fable-5-2', 'claude-sonnet-5-5',
        'codex-auto-review', 'grok-4.7', 'deepseek-v4.1-flash', 'grok-4-fast', 'group/auto-unknown', 'model_api/experimental_0812',
      ]);
      expect(overview.filters.options.models).toEqual(overview.modelCostShare);
      expect(overview.sankey.links).toContainEqual({ source: 'model-claude-opus-5-5', target: 'project-Test', value: 800 });

      const filtered = await (await handleOverview(request('overview', '&model=claude-opus-5-5&model=factory%2Fclaude-opus-5-5&model=gpt-6-astra'), env)).json<OverviewResponse>();
      expect(filtered.totalEvents).toBe(11);
      expect(filtered.totalCostUsd).toBe(12);

      const provider = await (await handleOverview(request('overview', '&model=claude-opus-5-5&provider=factory'), env)).json<OverviewResponse>();
      expect(provider.totalEvents).toBe(3);
      expect(provider.totalCostUsd).toBe(2);

      const breakdowns = await (await handleBreakdowns(request('breakdowns', '&model=claude-opus-5-5'), env)).json<BreakdownResponse>();
      expect(breakdowns.pagination.total).toBe(5);
      expect(breakdowns.data.map(row =>
        [row.model, row.provider, row.estimated_cost_usd],
      )).toEqual(expect.arrayContaining([
        ['claude-opus-5-5', 'anthropic', 4],
        ['factory/claude-opus-5-5', 'factory', 2],
        ['group/auto-claude-opus-5-5', 'group', 0],
        ['factory/claude-opus-5.5-fast', 'factory', 0],
        ['group/auto-claude-opus-5-5-fast:high', 'group', 0],
      ]));
      const raw = await (await handleBreakdowns(request('breakdowns', '&model=factory%2Fclaude-opus-5-5'), env)).json<BreakdownResponse>();
      expect(raw.pagination.total).toBe(1);
      expect(raw.data[0].model).toBe('factory/claude-opus-5-5');
    } finally {
      db.close();
    }
  });
});

it('groups AGY reasoning modes in model shares, filters and flow without changing stored usage', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const migration of ['0001_init.sql', '0002_project_fields.sql', '0004_daily_activity.sql']) {
      db.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
    }
    db.exec(`
      INSERT INTO devices (device_id, public_label, timezone, first_seen_at, last_seen_at)
      VALUES ('mac', 'Mac', 'UTC', '2026-11-23', '2026-11-23');
      INSERT INTO daily_usage (device_id, usage_date, created_at, updated_at)
      VALUES ('mac', '2026-11-23', '2026-11-23', '2026-11-23');
    `);
    const rows = ['gemini-4-neon-low', 'gemini-4-neon-xhigh', 'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'gpt-oss-120b-medium'];
    const insert = db.prepare(`INSERT INTO daily_usage_breakdown
      (device_id, usage_date, provider, product, model, project, project_display, estimated_cost_usd, event_count, input_tokens, output_tokens, reasoning_output_tokens, created_at, updated_at)
      VALUES ('mac', '2026-11-23', 'google', 'antigravity', ?, 'test', 'Test', 1, 1, 100, 20, 30, '2026-11-23', '2026-11-23')`);
    for (const model of rows) insert.run(model);
    const env = { PUBLIC_PROJECT_VISIBILITY: 'plain', DB: { prepare(sql: string) {
      const statement = db.prepare(sql);
      return { bind: (...params: SQLInputValue[]) => ({ first: async () => statement.get(...params), all: async () => ({ results: statement.all(...params) }) }) };
    } } } as unknown as Env;
    const url = (query = '') => new URL(`https://example.test/overview?range=all&product=antigravity${query}`);
    const overview = await (await handleOverview(url(), env)).json<OverviewResponse>();
    expect(overview.totalEvents).toBe(5);
    expect(overview.totalCostUsd).toBe(5);
    expect(overview.tokenComposition.reduce((sum, day) => sum + day.totalTokens, 0)).toBe(750);
    expect(overview.modelCostShare.map(row => row.value).sort()).toEqual(['claude-opus-5-5', 'gemini-4-neon', 'gpt-oss-120b']);
    expect(overview.filters.options.models).toEqual(overview.modelCostShare);
    expect(overview.sankey.links).toContainEqual({ source: 'model-gemini-4-neon', target: 'project-Test', value: 300 });
    const filtered = await (await handleOverview(url('&model=gemini-4-neon'), env)).json<OverviewResponse>();
    expect(filtered.totalEvents).toBe(2);
    expect(filtered.tokenComposition.reduce((sum, day) => sum + day.totalTokens, 0)).toBe(300);
    expect(filtered.totalCostUsd).toBe(2);
    expect(db.prepare('SELECT model FROM daily_usage_breakdown ORDER BY model').all().map(row => row.model)).toEqual([...rows].sort());
  } finally {
    db.close();
  }
});
