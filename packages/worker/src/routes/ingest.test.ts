import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { handleIngest } from './ingest.js';
import { signDeviceToken } from '../utils/token.js';
import type { Env } from '../types.js';

function createMockDb(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      return {
        bind(...params: SQLInputValue[]) {
          return {
            _run: () => stmt.run(...params),
            first: async () => stmt.get(...params) ?? null,
            all: async () => ({ results: stmt.all(...params) }),
            run: async () => stmt.run(...params),
          };
        },
      };
    },
    async batch(statements: Array<{ _run?: () => unknown }>) {
      return statements.map(s => s._run?.());
    },
  };
}

describe('handleIngest legacy routed Claude Code cleanup', () => {
  it('removes stale group/factory Claude Code CLI rows when uploading a normalized snapshot', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      for (const migration of ['0001_init.sql', '0002_project_fields.sql', '0004_daily_activity.sql']) {
        db.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'));
      }
      db.exec(`
        INSERT INTO devices (device_id, public_label, timezone, status, token_version, first_seen_at, last_seen_at)
        VALUES ('dev-1', 'Mac', 'UTC', 'active', 1, '2026-11-17', '2026-11-17');
        INSERT INTO daily_usage (device_id, usage_date, created_at, updated_at)
        VALUES ('dev-1', '2026-11-17', '2026-11-17', '2026-11-17');
        INSERT INTO daily_usage_breakdown
          (device_id, usage_date, provider, product, channel, model, project, project_display,
           event_count, input_tokens, output_tokens, estimated_cost_usd, cost_status, created_at, updated_at)
        VALUES
          ('dev-1', '2026-11-17', 'group', 'claude-code', 'cli', 'group/auto-claude-opus-5-5', 'proj', 'proj', 10, 100000, 50000, 0, 'unavailable', '2026-11-17', '2026-11-17'),
          ('dev-1', '2026-11-17', 'openai', 'codex', 'cli', 'gpt-6.1-sol', 'proj', 'proj', 2, 10000, 1000, 0.03, 'exact', '2026-11-17', '2026-11-17');
      `);

      const secret = 'test-secret';
      const token = await signDeviceToken({
        siteId: 'site-1',
        deviceId: 'dev-1',
        tokenVersion: 1,
        issuedAt: '2026-11-17T00:00:00Z',
      }, secret);

      const env = {
        DEVICE_TOKEN_SECRET: secret,
        DB: createMockDb(db),
      } as unknown as Env;

      const req = new Request('https://example.test/api/v1/ingest/daily', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          siteId: 'site-1',
          device: { deviceId: 'dev-1', deviceAlias: 'Mac', appVersion: '1.8.7' },
          days: [{
            usageDate: '2026-11-17',
            breakdowns: [
              {
                provider: 'anthropic',
                product: 'claude-code',
                channel: 'cli',
                model: 'claude-opus-5-5',
                project: 'proj',
                projectDisplay: 'proj',
                eventCount: 12,
                inputTokens: 100_000,
                cachedInputTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 100_000,
                reasoningOutputTokens: 0,
              },
              {
                provider: 'xai',
                product: 'claude-code',
                channel: 'cli',
                model: 'grok-4.7',
                project: 'proj',
                projectDisplay: 'proj',
                eventCount: 1,
                inputTokens: 100_000,
                cachedInputTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 100_000,
                reasoningOutputTokens: 0,
              },
            ],
          }],
        }),
      });

      const res = await handleIngest(req, env);
      expect(res.status).toBe(200);
      const body = await res.json<{ costSummary: Record<string, { estimatedCostUsd: number; costStatus: string }> }>();
      expect(body.costSummary['2026-11-17']).toEqual({
        estimatedCostUsd: 3.2,
        costStatus: 'exact',
      });

      const rows = db.prepare(`
        SELECT provider, product, model, estimated_cost_usd, cost_status
        FROM daily_usage_breakdown
        WHERE device_id = 'dev-1' AND usage_date = '2026-11-17'
        ORDER BY provider, model
      `).all();

      expect(rows).toEqual([
        { provider: 'anthropic', product: 'claude-code', model: 'claude-opus-5-5', estimated_cost_usd: 2.4, cost_status: 'exact' },
        { provider: 'openai', product: 'codex', model: 'gpt-6.1-sol', estimated_cost_usd: 0.03, cost_status: 'exact' },
        { provider: 'xai', product: 'claude-code', model: 'grok-4.7', estimated_cost_usd: 0.8, cost_status: 'exact' },
      ]);
    } finally {
      db.close();
    }
  });
});
