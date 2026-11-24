import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverGrokProjects, discoverGrokUsageDates, parseGrokRecord, scanGrokDates } from '../grok.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `aiusage-grok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeUpdates(projectDirName: string, sessionId: string, lines: object[]): Promise<void> {
  const dir = join(tmpDir, 'sessions', projectDirName, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'updates.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
}

function grokTurnCompleted(opts: {
  sessionId: string;
  promptId: string;
  timestampMs: number;
  usage: Record<string, unknown>;
}): object {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: opts.sessionId,
      _meta: { agentTimestampMs: opts.timestampMs },
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: opts.promptId,
        usage: opts.usage,
      },
    },
  };
}

describe('Grok CLI scanner', () => {
  it('parses turn_completed events, splits inclusive tokens, adopts costUsdTicks, and decodes project paths', async () => {
    const encodedProject = encodeURIComponent('/Users/test/Projects/macOS');
    const tsMs = Date.parse('2026-11-17T12:00:00.000Z');
    await writeUpdates(encodedProject, 'session-1', [
      grokTurnCompleted({
        sessionId: 'session-1',
        promptId: 'prompt-1',
        timestampMs: tsMs,
        usage: {
          inputTokens: 100_000,
          cachedReadTokens: 60_000,
          outputTokens: 10_000,
          reasoningTokens: 4_000,
          costUsdTicks: 50_000_000_000,
          modelUsage: {
            'grok-4.7-build': {
              inputTokens: 100_000,
              cachedReadTokens: 60_000,
              outputTokens: 10_000,
              reasoningTokens: 4_000,
              costUsdTicks: 50_000_000_000, // $5.00
            },
          },
        },
      }),
    ]);

    const result = await scanGrokDates(['2026-11-17'], join(tmpDir, 'sessions'));
    const rows = result.get('2026-11-17')!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'xai',
      product: 'grok-cli',
      channel: 'cli',
      model: 'grok-4.7-build',
      project: '/Users/test/Projects/macOS',
      eventCount: 1,
      inputTokens: 40_000,
      cachedInputTokens: 60_000,
      cacheWriteTokens: 0,
      outputTokens: 6_000,
      reasoningOutputTokens: 4_000,
      costUSD: 5,
      pricingVersion: 'grok-provider',
      sessionCount: 1,
    });
  });

  it('distributes total costUsdTicks proportionally across unticked models in a turn', () => {
    const tsMs = Date.parse('2026-11-17T12:00:00.000Z');
    const records = parseGrokRecord(
      grokTurnCompleted({
        sessionId: 'sess-split',
        promptId: 'prompt-split',
        timestampMs: tsMs,
        usage: {
          inputTokens: 600,
          outputTokens: 400,
          costUsdTicks: 30_000_000_000, // $3.00 total
          modelUsage: {
            'grok-4.7': {
              inputTokens: 100,
              cachedReadTokens: 0,
              outputTokens: 100,
              reasoningTokens: 0,
              costUsdTicks: 10_000_000_000, // $1.00 explicit
            },
            'grok-4.7-mini': {
              inputTokens: 300,
              cachedReadTokens: 0,
              outputTokens: 100,
              reasoningTokens: 0,
              // remaining $2.00 split 400/(400+400) = 50% -> $1.00
            },
            'grok-4.7-fast': {
              inputTokens: 200,
              cachedReadTokens: 0,
              outputTokens: 200,
              reasoningTokens: 0,
              // remaining $2.00 split 400/(400+400) = 50% -> $1.00
            },
          },
        },
      }),
      { project: '/Users/test/repo', projectDisplay: 'repo' },
    );

    const byModel = new Map(records.map((r) => [r.model, r]));
    expect(byModel.get('grok-4.7')?.costUsd).toBeCloseTo(1, 6);
    expect(byModel.get('grok-4.7-mini')?.costUsd).toBeCloseTo(1, 6);
    expect(byModel.get('grok-4.7-fast')?.costUsd).toBeCloseTo(1, 6);
  });

  it('deduplicates repeated events across files and keeps the smallest copy', async () => {
    const encodedA = encodeURIComponent('/Users/test/repo');
    const encodedB = encodeURIComponent('/Users/test/repo-copy');
    const tsMs = Date.parse('2026-11-17T12:00:00.000Z');
    await writeUpdates(encodedA, 'shared-session', [
      grokTurnCompleted({
        sessionId: 'shared-session',
        promptId: 'prompt-dup',
        timestampMs: tsMs,
        usage: {
          inputTokens: 1000,
          outputTokens: 500,
          costUsdTicks: 20_000_000_000,
          modelUsage: {
            'grok-4.7': { inputTokens: 1000, cachedReadTokens: 0, outputTokens: 500, reasoningTokens: 0, costUsdTicks: 20_000_000_000 },
          },
        },
      }),
    ]);
    await writeUpdates(encodedB, 'shared-session', [
      grokTurnCompleted({
        sessionId: 'shared-session',
        promptId: 'prompt-dup',
        timestampMs: tsMs,
        usage: {
          inputTokens: 600,
          outputTokens: 200,
          costUsdTicks: 10_000_000_000,
          modelUsage: {
            'grok-4.7': { inputTokens: 600, cachedReadTokens: 0, outputTokens: 200, reasoningTokens: 0, costUsdTicks: 10_000_000_000 },
          },
        },
      }),
    ]);

    const rows = (await scanGrokDates(['2026-11-17'], join(tmpDir, 'sessions'))).get('2026-11-17')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].eventCount).toBe(1);
    expect(rows[0].inputTokens).toBe(600);
    expect(rows[0].outputTokens).toBe(200);
    expect(rows[0].costUSD).toBeCloseTo(1, 6);
  });

  it('discovers projects and usage dates from updates.jsonl files', async () => {
    const encoded = encodeURIComponent('/Users/test/Projects/demo');
    const tsMs = Date.parse('2026-11-17T12:00:00.000Z');
    await writeUpdates(encoded, 's1', [
      grokTurnCompleted({
        sessionId: 's1',
        promptId: 'p1',
        timestampMs: tsMs,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          modelUsage: { 'grok-4.7': { inputTokens: 100, outputTokens: 20 } },
        },
      }),
    ]);

    const projects = await discoverGrokProjects(join(tmpDir, 'sessions'));
    expect(projects).toContain('demo');

    const dates = await discoverGrokUsageDates(join(tmpDir, 'sessions'));
    expect(dates).toContain('2026-11-17');
  });
});
