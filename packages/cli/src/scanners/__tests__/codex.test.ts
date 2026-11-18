import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { calculateCost, PRICING_VERSION } from '@aiusage/shared';
import { scanCodex } from '../codex.js';

// Helper to write a JSONL session file
async function writeSession(dir: string, filename: string, lines: object[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const content = lines.map((l) => JSON.stringify(l)).join('\n');
  await writeFile(join(dir, filename), content);
}

function tokenCountEvent(
  timestamp: string,
  last: { input: number; cached: number; cacheWrite?: number; output: number; reasoning?: number },
  total: { input: number; cached: number; cacheWrite?: number; output: number; reasoning?: number },
  model = 'gpt-5-codex',
  cwd = '/Users/test/project',
): object[] {
  // turn_context sets model/project
  const ctx = {
    type: 'turn_context',
    timestamp,
    payload: { model, cwd },
  };
  const ev = {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: last.input,
          cached_input_tokens: last.cached,
          cache_write_input_tokens: last.cacheWrite ?? 0,
          output_tokens: last.output,
          reasoning_output_tokens: last.reasoning ?? 0,
        },
        total_token_usage: {
          input_tokens: total.input,
          cached_input_tokens: total.cached,
          cache_write_input_tokens: total.cacheWrite ?? 0,
          output_tokens: total.output,
          reasoning_output_tokens: total.reasoning ?? 0,
        },
      },
    },
  };
  return [ctx, ev];
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `aiusage-test-${Date.now()}`);
  await mkdir(join(tmpDir, 'sessions'), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── Fix 1: cached input is included in input_tokens — should NOT double-count ───

describe('Fix 1: non-cached input cost formula', () => {
  it('prices GPT-6.2 Ultrafast at the time of each request', async () => {
    const timestamp = '2027-03-01T07:59:59.999Z';
    const day = new Date(timestamp).toLocaleDateString('sv-SE');
    const usage = { input: 100_000, cached: 0, output: 10_000, reasoning: 4_000 };
    const sessionDir = join(tmpDir, 'sessions');
    const filename = 'rollout-gpt62.jsonl';
    await writeSession(sessionDir, filename,
      tokenCountEvent(timestamp, usage, usage, 'gpt-6.2-sol-ultrafast'));
    await utimes(join(sessionDir, filename), new Date(timestamp), new Date(timestamp));

    const [result] = await scanCodex(day, tmpDir);
    expect(result).toMatchObject({
      model: 'gpt-6.2-sol-ultrafast', outputTokens: 6_000, reasoningOutputTokens: 4_000,
      costUSD: 0.9, pricingVersion: PRICING_VERSION,
    });
  });
  it('stores inputTokens as (input - cached) to avoid double-counting', async () => {
    // Codex JSONL: input_tokens INCLUDES cached_input_tokens
    // last_token_usage: input=10000, cached=8000 → non-cached = 2000
    const day = '2025-10-16';
    const sessionDir = join(tmpDir, 'sessions', '2025', '10', '16');
    const events = tokenCountEvent(
      `${day}T10:00:00.000Z`,
      { input: 10000, cached: 8000, output: 500 },
      { input: 10000, cached: 8000, output: 500 },
    );
    await writeSession(sessionDir, 'rollout-test.jsonl', events);

    const results = await scanCodex(day, tmpDir);
    expect(results).toHaveLength(1);
    const r = results[0];
    // inputTokens should be non-cached portion only: 10000 - 8000 = 2000
    expect(r.inputTokens).toBe(2000);
    expect(r.cachedInputTokens).toBe(8000);
    expect(r.outputTokens).toBe(500);
  });

  it('handles fully cached input (input === cached) without going negative', async () => {
    const day = '2025-10-16';
    const sessionDir = join(tmpDir, 'sessions', '2025', '10', '16');
    const events = tokenCountEvent(
      `${day}T10:00:00.000Z`,
      { input: 5000, cached: 5000, output: 200 },
      { input: 5000, cached: 5000, output: 200 },
    );
    await writeSession(sessionDir, 'rollout-test.jsonl', events);

    const results = await scanCodex(day, tmpDir);
    expect(results[0].inputTokens).toBe(0); // 5000 - 5000, no negative
    expect(results[0].cachedInputTokens).toBe(5000);
  });

  it('splits reasoning from inclusive Codex output without changing output cost', async () => {
    const day = '2026-09-05';
    const sessionDir = join(tmpDir, 'sessions', '2026', '09', '05');
    const events = tokenCountEvent(
      `${day}T10:00:00.000Z`,
      { input: 10_000, cached: 8_000, output: 500, reasoning: 200 },
      { input: 10_000, cached: 8_000, output: 500, reasoning: 200 },
      'gpt-6-astra',
    );
    await writeSession(sessionDir, 'rollout-test.jsonl', events);

    const [result] = await scanCodex(day, tmpDir);
    const expectedCost = calculateCost('openai', 'codex', 'gpt-6-astra', {
      inputTokens: 2_000,
      cachedInputTokens: 8_000,
      cacheWriteTokens: 0,
      outputTokens: 500,
    });
    expect(result.outputTokens).toBe(300);
    expect(result.reasoningOutputTokens).toBe(200);
    expect(result.outputTokens + result.reasoningOutputTokens).toBe(500);
    expect(result.costUSD).toBeCloseTo(expectedCost.estimatedCostUsd, 8);
  });

  it('carves cache writes out of uncached input and preserves their cost', async () => {
    const day = '2026-09-05';
    const sessionDir = join(tmpDir, 'sessions', '2026', '09', '05');
    const events = tokenCountEvent(
      `${day}T10:00:00.000Z`,
      { input: 100_000, cached: 60_000, cacheWrite: 30_000, output: 10_000 },
      { input: 100_000, cached: 60_000, cacheWrite: 30_000, output: 10_000 },
      'gpt-6-astra',
    );
    await writeSession(sessionDir, 'rollout-test.jsonl', events);

    const [result] = await scanCodex(day, tmpDir);
    expect(result.inputTokens).toBe(10_000);
    expect(result.cachedInputTokens).toBe(60_000);
    expect(result.cacheWriteTokens).toBe(30_000);
    expect(result.costUSD).toBeCloseTo(1.035, 4);
    expect(result.pricingVersion).toBe(PRICING_VERSION);
  });

  it('accumulates multiple turns with correct non-cached split', async () => {
    const day = '2025-10-16';
    const sessionDir = join(tmpDir, 'sessions', '2025', '10', '16');
    // Turn 1: input=3000, cached=2000 → non-cached=1000
    // Turn 2: input=4000, cached=3000 → non-cached=1000
    const lines = [
      ...tokenCountEvent(
        `${day}T10:00:00.000Z`,
        { input: 3000, cached: 2000, output: 100 },
        { input: 3000, cached: 2000, output: 100 },
      ),
      ...tokenCountEvent(
        `${day}T10:05:00.000Z`,
        { input: 4000, cached: 3000, output: 150 },
        { input: 7000, cached: 5000, output: 250 },
      ),
    ];
    await writeSession(sessionDir, 'rollout-test.jsonl', lines);

    const results = await scanCodex(day, tmpDir);
    expect(results[0].inputTokens).toBe(2000);     // (3000-2000) + (4000-3000)
    expect(results[0].cachedInputTokens).toBe(5000); // 2000 + 3000
    expect(results[0].outputTokens).toBe(250);
  });
});

describe('Codex tiered pricing', () => {
  it('accumulates mixed short and long requests at their individual tiers', async () => {
    const day = '2026-07-10';
    const sessionDir = join(tmpDir, 'sessions', '2026', '07', '10');
    const lines = [
      ...tokenCountEvent(
        `${day}T10:00:00.000Z`,
        { input: 100_000, cached: 0, output: 10_000 },
        { input: 100_000, cached: 0, output: 10_000 },
        'gpt-5.6-sol',
      ),
      ...tokenCountEvent(
        `${day}T10:05:00.000Z`,
        { input: 400_000, cached: 0, output: 10_000 },
        { input: 500_000, cached: 0, output: 20_000 },
        'gpt-5.6-sol',
      ),
    ];
    await writeSession(sessionDir, 'rollout-test.jsonl', lines);

    const [result] = await scanCodex(day, tmpDir);
    expect(result.eventCount).toBe(2);
    expect(result.inputTokens).toBe(500_000);
    expect(result.outputTokens).toBe(20_000);
    expect(result.costUSD).toBeCloseTo(4.1, 4);
    expect(result.pricingVersion).toBe(PRICING_VERSION);
  });
});

describe('Codex service tier', () => {
  it('adds fast suffix for GPT-6 Astra Codex usage', async () => {
    const day = '2026-09-05';
    await writeFile(join(tmpDir, 'config.toml'), 'service_tier = "fast"\n');
    const sessionDir = join(tmpDir, 'sessions', '2026', '09', '05');
    const events = tokenCountEvent(
      `${day}T10:00:00.000Z`,
      { input: 10_000, cached: 8_000, output: 500 },
      { input: 10_000, cached: 8_000, output: 500 },
      'gpt-6-astra',
    );
    await writeSession(sessionDir, 'rollout-test.jsonl', events);

    const [result] = await scanCodex(day, tmpDir);
    expect(result.model).toBe('gpt-6-astra-fast');
  });

  it('adds priority suffix for GPT-5.6 Codex usage', async () => {
    const day = '2026-07-10';
    await writeFile(join(tmpDir, 'config.toml'), 'service_tier = "priority"\n');
    const sessionDir = join(tmpDir, 'sessions', '2026', '07', '10');
    const events = tokenCountEvent(
      `${day}T10:00:00.000Z`,
      { input: 10000, cached: 8000, output: 500 },
      { input: 10000, cached: 8000, output: 500 },
      'gpt-5.6-sol',
    );
    await writeSession(sessionDir, 'rollout-test.jsonl', events);

    const results = await scanCodex(day, tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].model).toBe('gpt-5.6-sol-priority');
  });

  it('does not add fast suffix to GPT-5.6 while Codex Fast is unsupported', async () => {
    const day = '2026-07-10';
    await writeFile(join(tmpDir, 'config.toml'), 'service_tier = "fast"\n');
    const sessionDir = join(tmpDir, 'sessions', '2026', '07', '10');
    const events = tokenCountEvent(
      `${day}T10:00:00.000Z`,
      { input: 10000, cached: 8000, output: 500 },
      { input: 10000, cached: 8000, output: 500 },
      'gpt-5.6-sol',
    );
    await writeSession(sessionDir, 'rollout-test.jsonl', events);

    const results = await scanCodex(day, tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].model).toBe('gpt-5.6-sol');
  });

  it('adds priority suffix for supported GPT-5.5 Codex usage', async () => {
    const day = '2026-06-22';
    await writeFile(join(tmpDir, 'config.toml'), 'service_tier = "priority"\n');
    const sessionDir = join(tmpDir, 'sessions', '2026', '06', '22');
    const events = tokenCountEvent(
      `${day}T10:00:00.000Z`,
      { input: 10000, cached: 8000, output: 500 },
      { input: 10000, cached: 8000, output: 500 },
      'gpt-5.5',
    );
    await writeSession(sessionDir, 'rollout-test.jsonl', events);

    const results = await scanCodex(day, tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].model).toBe('gpt-5.5-priority');
  });

  it('does not add service tier suffix to unsupported Codex models', async () => {
    const day = '2026-06-22';
    await writeFile(join(tmpDir, 'config.toml'), 'service_tier = "priority"\n');
    const sessionDir = join(tmpDir, 'sessions', '2026', '06', '22');
    const events = tokenCountEvent(
      `${day}T10:00:00.000Z`,
      { input: 10000, cached: 8000, output: 500 },
      { input: 10000, cached: 8000, output: 500 },
      'codex-auto-review',
    );
    await writeSession(sessionDir, 'rollout-test.jsonl', events);

    const results = await scanCodex(day, tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].model).toBe('codex-auto-review');
  });
});

// ─── Fix 2: deduplicate events with identical total_token_usage ───

describe('Fix 2: deduplication of duplicate events', () => {
  it('skips exact duplicate events (same total_token_usage emitted twice)', async () => {
    const day = '2025-10-16';
    const sessionDir = join(tmpDir, 'sessions', '2025', '10', '16');
    // Codex CLI emits each token_count event 2× with identical data
    const singleEvent = {
      type: 'event_msg',
      timestamp: `${day}T10:00:00.000Z`,
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 100 },
          total_token_usage: { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 100 },
        },
      },
    };
    await writeSession(sessionDir, 'rollout-test.jsonl', [
      { type: 'turn_context', timestamp: `${day}T10:00:00.000Z`, payload: { model: 'gpt-5-codex', cwd: '/p' } },
      singleEvent,
      singleEvent, // exact duplicate
    ]);

    const results = await scanCodex(day, tmpDir);
    expect(results).toHaveLength(1);
    // Should count as 1 event, not 2
    expect(results[0].eventCount).toBe(1);
    expect(results[0].inputTokens).toBe(1000); // 3000-2000
    expect(results[0].cachedInputTokens).toBe(2000);
  });

  it('correctly counts 2 distinct turns even when totals are close', async () => {
    const day = '2025-10-16';
    const sessionDir = join(tmpDir, 'sessions', '2025', '10', '16');
    const lines = [
      { type: 'turn_context', timestamp: `${day}T10:00:00.000Z`, payload: { model: 'gpt-5-codex', cwd: '/p' } },
      // Turn 1 (emitted twice — only count once)
      {
        type: 'event_msg',
        timestamp: `${day}T10:00:01.000Z`,
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 100 },
            total_token_usage: { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 100 },
          },
        },
      },
      {
        type: 'event_msg',
        timestamp: `${day}T10:00:01.400Z`, // 0.4s later, identical
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 100 },
            total_token_usage: { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 100 },
          },
        },
      },
      // Turn 2 (new total)
      {
        type: 'event_msg',
        timestamp: `${day}T10:05:00.000Z`,
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 4000, cached_input_tokens: 3000, output_tokens: 150 },
            total_token_usage: { input_tokens: 7000, cached_input_tokens: 5000, output_tokens: 250 },
          },
        },
      },
      {
        type: 'event_msg',
        timestamp: `${day}T10:05:00.400Z`, // duplicate of turn 2
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 4000, cached_input_tokens: 3000, output_tokens: 150 },
            total_token_usage: { input_tokens: 7000, cached_input_tokens: 5000, output_tokens: 250 },
          },
        },
      },
    ];
    await writeSession(sessionDir, 'rollout-test.jsonl', lines);

    const results = await scanCodex(day, tmpDir);
    expect(results[0].eventCount).toBe(2); // 2 unique turns
    expect(results[0].inputTokens).toBe(2000);     // (3000-2000) + (4000-3000)
    expect(results[0].cachedInputTokens).toBe(5000); // 2000 + 3000
    expect(results[0].outputTokens).toBe(250);       // 100 + 150
  });

  it('does not drop real turns across sessions that each start with a zero total', async () => {
    const day = '2025-10-16';
    const dir = join(tmpDir, 'sessions', '2025', '10', '16');
    // 两个独立会话，开头都带一个全零 total（会话开头噪声）。
    // 旧逻辑下第二个会话的全零会命中第一个的签名而被丢弃，进而连累后续 delta 计算；
    // 修复后全零不参与去重，两个会话的真实 turn 都应保留。
    const zeroEvent = (ts: string) => ({
      type: 'event_msg',
      timestamp: ts,
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
          total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
        },
      },
    });
    const realEvent = (ts: string, out: number) => ({
      type: 'event_msg',
      timestamp: ts,
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: out },
          total_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: out },
        },
      },
    });
    const ctx = { type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/p' } };
    await writeSession(dir, 'session-a.jsonl', [
      { ...ctx, timestamp: `${day}T10:00:00.000Z` },
      zeroEvent(`${day}T10:00:00.500Z`),
      realEvent(`${day}T10:00:05.000Z`, 80),
    ]);
    await writeSession(dir, 'session-b.jsonl', [
      { ...ctx, timestamp: `${day}T11:00:00.000Z` },
      zeroEvent(`${day}T11:00:00.500Z`),
      realEvent(`${day}T11:00:05.000Z`, 120),
    ]);

    const results = await scanCodex(day, tmpDir);
    expect(results[0].eventCount).toBe(2); // 两个会话各 1 笔真实 turn，全零不计
    expect(results[0].outputTokens).toBe(200); // 80 + 120
  });

  it('不会因两个独立 session 的累计 token 完全相同而误杀其中一个', async () => {
    const day = '2025-10-16';
    const dir = join(tmpDir, 'sessions', '2025', '10', '16');
    for (const id of ['session-a', 'session-b']) {
      await writeSession(dir, `${id}.jsonl`, [
        { type: 'session_meta', payload: { id, cwd: '/same-project' } },
        { type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/same-project' } },
        {
          type: 'event_msg', timestamp: `${day}T10:00:00.000Z`,
          payload: { type: 'token_count', info: {
            total_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
            last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
          } },
        },
      ]);
    }

    const results = await scanCodex(day, tmpDir);
    expect(results[0]).toEqual(expect.objectContaining({
      eventCount: 2, inputTokens: 100, cachedInputTokens: 100, outputTokens: 20,
    }));
  });

  it('同一 session 在活动目录和归档目录各一份时仍只统计一次', async () => {
    const day = '2025-10-16';
    const lines = [
      { type: 'session_meta', payload: { id: 'same-session', cwd: '/same-project' } },
      { type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/same-project' } },
      {
        type: 'event_msg', timestamp: `${day}T10:00:00.000Z`,
        payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
        } },
      },
    ];
    await writeSession(join(tmpDir, 'sessions', '2025', '10', '16'), 'active.jsonl', lines);
    const archivedLines = lines.map((line) => JSON.parse(
      JSON.stringify(line).replaceAll('/same-project', '/stale-archived-project'),
    ));
    await writeSession(join(tmpDir, 'archived_sessions', 'nested'), 'archived.jsonl', archivedLines);

    const results = await scanCodex(day, tmpDir);
    expect(results[0]).toEqual(expect.objectContaining({
      project: '/same-project', eventCount: 1, outputTokens: 10,
    }));
  });

  it('session_meta 的初始 workspace 优先于后续 turn_context cwd', async () => {
    const day = '2025-10-16';
    await writeSession(join(tmpDir, 'sessions', '2025', '10', '16'), 'workspace.jsonl', [
      { type: 'session_meta', payload: { id: 'workspace-session', cwd: '/origin-project' } },
      { type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/later-cwd' } },
      {
        type: 'event_msg', timestamp: `${day}T10:00:00.000Z`,
        payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
        } },
      },
    ]);

    const results = await scanCodex(day, tmpDir);
    expect(results[0]).toEqual(expect.objectContaining({ project: '/origin-project' }));
  });

  it('子会话跳过复制的父历史，只统计超过继承基线的自身 turn', async () => {
    const day = '2025-10-16';
    const dir = join(tmpDir, 'sessions', '2025', '10', '16');
    const parentId = '019e5b00-0000-7000-8000-000000000001';
    const childId = '019e5c03-0000-7000-8000-000000000001';
    await writeSession(dir, 'child.jsonl', [
      {
        type: 'session_meta',
        payload: {
          id: childId,
          forked_from_id: parentId,
          source: { subagent: { thread_spawn: { parent_thread_id: parentId } } },
          cwd: '/child-project',
        },
      },
      { type: 'session_meta', payload: { id: parentId, cwd: '/parent-project' } },
      { type: 'turn_context', payload: { turn_id: parentId, model: 'gpt-5-codex', cwd: '/parent-project' } },
      {
        type: 'event_msg', timestamp: `${day}T10:00:00.000Z`,
        payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 30, total_tokens: 330 },
          last_token_usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 30, total_tokens: 330 },
        } },
      },
      {
        type: 'event_msg', timestamp: `${day}T10:00:00.500Z`,
        payload: { type: 'task_started', turn_id: childId },
      },
      { type: 'turn_context', payload: { turn_id: childId, model: 'gpt-5-codex' } },
      {
        type: 'event_msg', timestamp: `${day}T10:00:01.000Z`,
        payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 30, total_tokens: 330 },
          last_token_usage: { input_tokens: 250, cached_input_tokens: 180, output_tokens: 25, total_tokens: 275 },
        } },
      },
      {
        type: 'event_msg', timestamp: `${day}T10:00:02.000Z`,
        payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 320, cached_input_tokens: 210, output_tokens: 32, total_tokens: 352 },
          last_token_usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 2, total_tokens: 22 },
        } },
      },
    ]);

    const results = await scanCodex(day, tmpDir);
    expect(results).toEqual([
      expect.objectContaining({
        project: '/child-project', eventCount: 1, inputTokens: 10,
        cachedInputTokens: 10, outputTokens: 2,
      }),
    ]);
  });
});

// ─── Fix 3: fallback to delta when last_token_usage is absent ───

describe('Fix 3: delta fallback when last_token_usage is missing', () => {
  it('computes delta from total_token_usage when last_token_usage is absent', async () => {
    const day = '2025-10-16';
    const sessionDir = join(tmpDir, 'sessions', '2025', '10', '16');
    // Event 1: total=5000 input, no last_token_usage → delta = 5000-0 = 5000
    // Event 2: total=8000 input, no last_token_usage → delta = 8000-5000 = 3000
    const lines = [
      { type: 'turn_context', timestamp: `${day}T10:00:00.000Z`, payload: { model: 'gpt-5-codex', cwd: '/p' } },
      {
        type: 'event_msg',
        timestamp: `${day}T10:00:01.000Z`,
        payload: {
          type: 'token_count',
          info: {
            // no last_token_usage
            total_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 200 },
          },
        },
      },
      {
        type: 'event_msg',
        timestamp: `${day}T10:05:00.000Z`,
        payload: {
          type: 'token_count',
          info: {
            // no last_token_usage
            total_token_usage: { input_tokens: 8000, cached_input_tokens: 6000, output_tokens: 350 },
          },
        },
      },
    ];
    await writeSession(sessionDir, 'rollout-test.jsonl', lines);

    const results = await scanCodex(day, tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].eventCount).toBe(2);
    // Delta 1: input=5000, cached=4000 → non-cached=1000
    // Delta 2: input=3000 (8000-5000), cached=2000 (6000-4000) → non-cached=1000
    expect(results[0].inputTokens).toBe(2000);       // 1000 + 1000
    expect(results[0].cachedInputTokens).toBe(6000);  // 4000 + 2000
    expect(results[0].outputTokens).toBe(350);        // 200 + 150
  });

  it('skips events missing both last_token_usage and total_token_usage', async () => {
    const day = '2025-10-16';
    const sessionDir = join(tmpDir, 'sessions', '2025', '10', '16');
    await writeSession(sessionDir, 'rollout-test.jsonl', [
      { type: 'turn_context', timestamp: `${day}T10:00:00.000Z`, payload: { model: 'gpt-5-codex', cwd: '/p' } },
      {
        type: 'event_msg',
        timestamp: `${day}T10:00:01.000Z`,
        payload: { type: 'token_count', info: {} }, // no token data at all
      },
    ]);

    const results = await scanCodex(day, tmpDir);
    expect(results).toHaveLength(0);
  });
});

// ─── Fix 4: file glob matches all .jsonl files, not just rollout-* ───

describe('Fix 4: file glob includes all .jsonl files', () => {
  it('scans session files not prefixed with "rollout-"', async () => {
    const day = '2025-10-16';
    const sessionDir = join(tmpDir, 'sessions', '2025', '10', '16');
    const events = tokenCountEvent(
      `${day}T10:00:00.000Z`,
      { input: 3000, cached: 2000, output: 100 },
      { input: 3000, cached: 2000, output: 100 },
    );
    // Use a non-rollout filename
    await writeSession(sessionDir, 'session-abc123.jsonl', events);

    const results = await scanCodex(day, tmpDir);
    expect(results).toHaveLength(1);
    expect(results[0].inputTokens).toBe(1000);
  });

  it('scans both rollout-* and other .jsonl files in same directory', async () => {
    const day = '2025-10-16';
    const sessionDir = join(tmpDir, 'sessions', '2025', '10', '16');

    const eventsA = tokenCountEvent(
      `${day}T10:00:00.000Z`,
      { input: 2000, cached: 1000, output: 50 },
      { input: 2000, cached: 1000, output: 50 },
    );
    const eventsB = tokenCountEvent(
      `${day}T11:00:00.000Z`,
      { input: 4000, cached: 3000, output: 80 },
      { input: 4000, cached: 3000, output: 80 },
    );

    await writeSession(sessionDir, 'rollout-2025-10-16T10-00-00-abc.jsonl', eventsA);
    await writeSession(sessionDir, 'session-xyz.jsonl', eventsB);

    const results = await scanCodex(day, tmpDir);
    const total = results.reduce((s, r) => ({ inputTokens: s.inputTokens + r.inputTokens, cachedInputTokens: s.cachedInputTokens + r.cachedInputTokens }), { inputTokens: 0, cachedInputTokens: 0 });
    expect(total.inputTokens).toBe(2000);       // (2000-1000) + (4000-3000)
    expect(total.cachedInputTokens).toBe(4000); // 1000 + 3000
  });
});

// ─── Integration: multiple fixes together ───

describe('Integration: real-world duplicate pattern', () => {
  it('handles the 2× duplicate emission pattern from Codex CLI correctly', async () => {
    // Simulates the actual Codex CLI behavior: every turn emits 2 identical events
    const day = '2025-10-16';
    const sessionDir = join(tmpDir, 'sessions', '2025', '10', '16');

    const makeDupTurn = (ts: string, last: { input: number; cached: number; output: number }, total: typeof last) => [
      {
        type: 'event_msg', timestamp: ts,
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: last.input, cached_input_tokens: last.cached, output_tokens: last.output }, total_token_usage: { input_tokens: total.input, cached_input_tokens: total.cached, output_tokens: total.output } } },
      },
      {
        type: 'event_msg', timestamp: `${ts.slice(0, -5)}0.400Z`, // 0.4s later, identical
        payload: { type: 'token_count', info: { last_token_usage: { input_tokens: last.input, cached_input_tokens: last.cached, output_tokens: last.output }, total_token_usage: { input_tokens: total.input, cached_input_tokens: total.cached, output_tokens: total.output } } },
      },
    ];

    const lines = [
      { type: 'turn_context', timestamp: `${day}T10:00:00.000Z`, payload: { model: 'gpt-5-codex', cwd: '/proj' } },
      // Turn 1: input=3000, cached=2000 → non-cached=1000
      ...makeDupTurn(`${day}T10:00:01.000Z`, { input: 3000, cached: 2000, output: 100 }, { input: 3000, cached: 2000, output: 100 }),
      // Turn 2: input=5000, cached=4000 → non-cached=1000
      ...makeDupTurn(`${day}T10:05:01.000Z`, { input: 5000, cached: 4000, output: 200 }, { input: 8000, cached: 6000, output: 300 }),
      // Turn 3: input=4000, cached=3500 → non-cached=500
      ...makeDupTurn(`${day}T10:10:01.000Z`, { input: 4000, cached: 3500, output: 150 }, { input: 12000, cached: 9500, output: 450 }),
    ];
    await writeSession(sessionDir, 'rollout-test.jsonl', lines);

    const results = await scanCodex(day, tmpDir);
    expect(results[0].eventCount).toBe(3);    // 3 unique turns (not 6)
    expect(results[0].inputTokens).toBe(2500);       // 1000+1000+500
    expect(results[0].cachedInputTokens).toBe(9500);  // 2000+4000+3500
    expect(results[0].outputTokens).toBe(450);        // 100+200+150
  });
});
