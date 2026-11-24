import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as zlib from 'node:zlib';

const mockHomedir = vi.fn();

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => mockHomedir(),
  };
});

let homeDir: string;

beforeEach(async () => {
  homeDir = join(tmpdir(), `aiusage-report-${Date.now()}`);
  mockHomedir.mockReturnValue(homeDir);
  await mkdir(homeDir, { recursive: true });
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe('buildLocalReport', () => {
  it('discovers Gemini logs, Copilot VS Code workspace sessions, and Antigravity metadata in all-history reports', async () => {
    await mkdir(join(homeDir, '.gemini', 'tmp', 'project-a'), { recursive: true });
    await writeFile(
      join(homeDir, '.gemini', 'tmp', 'project-a', 'logs.json'),
      JSON.stringify([
        { type: 'user', timestamp: '2025-06-30T12:38:58.048Z' },
      ], null, 2),
    );

    await writeFile(
      join(homeDir, '.gemini', 'tmp', 'project-a', 'session.json'),
      JSON.stringify({
        data: {
          model: 'gemini-2.5-pro',
          messages: [
            {
              timestamp: '2025-09-17T12:40:13.941Z',
              usageMetadata: {
                promptTokenCount: 100,
                candidatesTokenCount: 50,
                cachedContentTokenCount: 20,
                thoughtsTokenCount: 5,
              },
            },
          ],
        },
      }, null, 2),
    );

    const workspaceDir = join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage', 'ws-1');
    await mkdir(join(workspaceDir, 'chatSessions'), { recursive: true });
    await writeFile(
      join(workspaceDir, 'workspace.json'),
      JSON.stringify({ folder: 'file:///Users/test/Copilot%20Project' }, null, 2),
    );
    await writeFile(
      join(workspaceDir, 'chatSessions', 'session-1.json'),
      JSON.stringify({
        requests: [
          {
            requestId: 'copilot-1',
            response: [{ value: 'Done' }],
            timestamp: Date.parse('2025-10-22T12:45:42.785Z'),
            modelId: 'copilot/claude-sonnet-4.5',
          },
        ],
      }, null, 2),
    );

    await mkdir(join(homeDir, '.gemini', 'antigravity', 'brain', 'session-a'), { recursive: true });
    await writeFile(
      join(homeDir, '.gemini', 'antigravity', 'brain', 'session-a', 'task.md.metadata.json'),
      JSON.stringify({ updatedAt: '2025-12-10T12:36:31.732646Z' }, null, 2),
    );

    const { buildLocalReport } = await import('../report.js');
    const report = await buildLocalReport('all');

    expect(report.daysWithData).toBe(4);
    expect(report.daily.map((day) => day.usageDate)).toEqual([
      '2025-06-30',
      '2025-09-17',
      '2025-10-22',
      '2025-12-10',
    ]);
  });

  it('discovers and reports Kimi Code usage from time-based usage.record lines', async () => {
    const sessionDir = join(
      homeDir,
      '.kimi-code',
      'sessions',
      'wd_aiusage_123456789abc',
      'session-1',
    );
    const agentDir = join(sessionDir, 'agents', 'main');
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify({ workDir: '/Users/test/Projects/AI/aiusage' }),
    );
    await writeFile(
      join(agentDir, 'wire.jsonl'),
      JSON.stringify({
        type: 'usage.record',
        model: 'kimi-code/k3',
        usage: {
          inputOther: 1_000_000,
          output: 100_000,
          inputCacheRead: 2_000_000,
          inputCacheCreation: 0,
        },
        usageScope: 'turn',
        time: Date.parse('2026-07-17T12:00:00Z'),
      }),
    );

    const { buildLocalReport } = await import('../report.js');
    const report = await buildLocalReport('all');

    expect(report.daily.map(day => day.usageDate)).toEqual(['2026-07-17']);
    expect(report.bySource).toContainEqual(
      expect.objectContaining({
        source: 'moonshot/kimi-code',
        eventCount: 1,
        inputTokens: 1_000_000,
        cachedInputTokens: 2_000_000,
        outputTokens: 100_000,
      }),
    );
  });

  it('limits all-history discovery and output to the selected Trae edition', async () => {
    const traeDir = join(homeDir, '.aiusage', 'trae-cache', 'sessions');
    const geminiDir = join(homeDir, '.gemini', 'tmp', 'other-project');
    await Promise.all([
      mkdir(traeDir, { recursive: true }),
      mkdir(geminiDir, { recursive: true }),
    ]);
    await writeFile(join(traeDir, 'session.json'), JSON.stringify({
      schemaVersion: 1,
      source: 'trae-cn-local-rpc',
      syncedAt: '2026-07-19T00:00:00Z',
      sessionId: 'trae-session',
      project: '/Users/test/Projects/trae',
      events: [{
        messageId: 'trae-message',
        timestamp: '2026-01-15T12:00:00Z',
        model: 'GPT-5.4',
        inputTokens: 100,
        cachedInputTokens: 200,
        cacheWriteTokens: 0,
        outputTokens: 10,
        reasoningOutputTokens: 0,
      }],
    }));
    await writeFile(join(geminiDir, 'session.json'), JSON.stringify({
      data: {
        model: 'gemini-2.5-pro',
        messages: [{
          timestamp: '2025-01-01T12:00:00Z',
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        }],
      },
    }));

    const { buildLocalReport } = await import('../report.js');
    const report = await buildLocalReport('all', { tools: ['trae-cn'] });

    expect(report.requestedDays).toBe(1);
    expect(report.daily.map(day => day.usageDate)).toEqual(['2026-01-15']);
    expect(report.bySource.map(source => source.source)).toEqual(['openai/trae-cn']);
    expect(report.totals.totalTokens).toBe(310);
  });

  it('discovers and reports compressed Codex .jsonl.zst sessions across sessions and archived_sessions in all-history reports', async () => {
    const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync;
    if (typeof zstdCompressSync !== 'function') return;

    const activeDir = join(homeDir, '.codex', 'sessions', '2026', '05', '10');
    const archivedDir = join(homeDir, '.codex', 'archived_sessions', '2026');
    await Promise.all([
      mkdir(activeDir, { recursive: true }),
      mkdir(archivedDir, { recursive: true }),
    ]);

    const activeLines = [
      { type: 'session_meta', timestamp: '2026-05-10T12:00:00.000Z', payload: { id: 'sess-zst-active', cwd: '/Users/test/repo-a' } },
      { type: 'turn_context', timestamp: '2026-05-10T12:00:00.000Z', payload: { model: 'gpt-6-astra', cwd: '/Users/test/repo-a' } },
      {
        type: 'event_msg',
        timestamp: '2026-05-10T12:00:05.000Z',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 10_000, cached_input_tokens: 6_000, output_tokens: 500 },
            total_token_usage: { input_tokens: 10_000, cached_input_tokens: 6_000, output_tokens: 500 },
          },
        },
      },
    ];
    const archivedLines = [
      { type: 'session_meta', timestamp: '2026-04-02T12:00:00.000Z', payload: { id: 'sess-zst-archived', cwd: '/Users/test/repo-b' } },
      { type: 'turn_context', timestamp: '2026-04-02T12:00:00.000Z', payload: { model: 'gpt-6-sol', cwd: '/Users/test/repo-b' } },
      {
        type: 'token_usage_record',
        timestamp: '2026-04-02T12:00:05.000Z',
        payload: {
          response_id: 'resp_archived_1',
          usage: { input_tokens: 5_000, cached_input_tokens: 2_000, output_tokens: 300 },
        },
      },
    ];

    await Promise.all([
      writeFile(
        join(activeDir, 'rollout-2026-05-10.jsonl.zst'),
        zstdCompressSync(Buffer.from(activeLines.map(l => JSON.stringify(l)).join('\n'), 'utf-8')),
      ),
      writeFile(
        join(archivedDir, 'session-archived-2026-04-02.jsonl.zst'),
        zstdCompressSync(Buffer.from(archivedLines.map(l => JSON.stringify(l)).join('\n'), 'utf-8')),
      ),
    ]);

    const { buildLocalReport } = await import('../report.js');
    const report = await buildLocalReport('all', { tools: ['codex'] });

    expect(report.daily.map(day => day.usageDate)).toEqual(['2026-04-02', '2026-05-10']);
    expect(report.totals.eventCount).toBe(2);
    expect(report.totals.inputTokens).toBe(7_000); // 4000 + 3000
    expect(report.totals.cachedInputTokens).toBe(8_000); // 6000 + 2000
    expect(report.totals.outputTokens).toBe(800); // 500 + 300
  });
});

describe('Trae CLI filters', () => {
  it('supports the 6-month range and expands the Trae alias to both editions', async () => {
    const { parseReportRange } = await import('../report.js');
    const { parseToolSelection } = await import('../scan.js');

    expect(parseReportRange('6m')).toBe('6m');
    expect(parseToolSelection('trae')).toEqual(['trae-cn', 'trae-intl', 'trae']);
    expect(parseToolSelection('trae-cn,trae-intl')).toEqual(['trae-cn', 'trae-intl']);
  });
});

describe('calculateBreakdownCost', () => {
  it('uses the usage date and includes reasoning in a GPT-6.2 fallback estimate', async () => {
    const { calculateBreakdownCost } = await import('../report.js');
    const cost = calculateBreakdownCost({
      provider: 'openai', product: 'codex', channel: 'cli', model: 'gpt-6.2-sol-ultrafast', project: 'unknown',
      eventCount: 2, inputTokens: 100_000, cachedInputTokens: 0, cacheWriteTokens: 0,
      outputTokens: 50_000, reasoningOutputTokens: 50_000,
    }, new Set(), undefined, '2026-11-18');
    expect(cost).toBe(3.6);
  });
  it('only trusts scanner cost when the selected catalog version matches', async () => {
    const { calculateBreakdownCost } = await import('../report.js');
    const { catalog } = await import('@aiusage/shared');
    const breakdown = {
      provider: 'openai' as const,
      product: 'codex' as const,
      channel: 'cli' as const,
      model: 'gpt-5.6-sol',
      project: '/tmp/project',
      eventCount: 2,
      inputTokens: 500_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20_000,
      reasoningOutputTokens: 0,
      costUSD: 4.1,
      pricingVersion: catalog.version,
    };

    expect(calculateBreakdownCost(breakdown, new Set(), catalog)).toBe(4.1);

    const warnings = new Set<string>();
    const futureCatalog = { ...catalog, version: 'future-catalog' };
    expect(calculateBreakdownCost(breakdown, warnings, futureCatalog)).toBe(2.4);
    expect([...warnings]).toEqual(['gpt-5.6-sol 的阶梯价格已按每事件平均输入量估算。']);
  });

  it('prices local Codex GPT-5.5 usage', async () => {
    const { calculateBreakdownCost } = await import('../report.js');
    const warnings = new Set<string>();

    const cost = calculateBreakdownCost({
      provider: 'openai',
      product: 'codex',
      channel: 'cli',
      model: 'gpt-5.5',
      project: '/tmp/project',
      eventCount: 1,
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 0,
      outputTokens: 500_000,
      reasoningOutputTokens: 0,
    }, warnings);

    expect(cost).toBe(33.5);
    expect([...warnings]).toEqual([]);
  });

  it('trusts Trae international vendor cost across catalog versions', async () => {
    const { calculateBreakdownCost } = await import('../report.js');
    const { catalog } = await import('@aiusage/shared');
    const warnings = new Set<string>();

    const cost = calculateBreakdownCost({
      provider: 'openai',
      product: 'trae-intl',
      channel: 'ide',
      model: 'gpt-5.4',
      project: 'unknown',
      eventCount: 1,
      inputTokens: 100,
      cachedInputTokens: 200,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningOutputTokens: 0,
      costUSD: 0.25,
      pricingVersion: 'older-cli',
    }, warnings, { ...catalog, version: 'future-catalog' });

    expect(cost).toBe(0.25);
    expect([...warnings]).toEqual([]);
  });

  it('trusts OpenCode provider-reported cost across catalog versions', async () => {
    const { calculateBreakdownCost } = await import('../report.js');
    const { catalog } = await import('@aiusage/shared');
    const warnings = new Set<string>();

    const cost = calculateBreakdownCost({
      provider: 'openai',
      product: 'opencode',
      channel: 'cli',
      model: 'gpt-5.6',
      project: '/tmp/project',
      eventCount: 1,
      inputTokens: 100,
      cachedInputTokens: 20,
      cacheWriteTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 0,
      costUSD: 0.42,
      pricingVersion: 'opencode-provider',
    }, warnings, { ...catalog, version: 'future-catalog' });

    expect(cost).toBe(0.42);
    expect([...warnings]).toEqual([]);
  });

  it('estimates Codex auto-review with gpt-5.4 pricing', async () => {
    const { calculateBreakdownCost } = await import('../report.js');
    const warnings = new Set<string>();

    const cost = calculateBreakdownCost({
      provider: 'openai',
      product: 'codex',
      channel: 'cli',
      model: 'codex-auto-review',
      project: '/tmp/project',
      eventCount: 1,
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
      reasoningOutputTokens: 0,
    }, warnings);

    expect(cost).toBe(28);
    // codex-auto-review 是 catalog 里的显式 alias → gpt-5.4，按 exact 处理，不应有 warning
    expect([...warnings]).toEqual([]);
  });

  it('estimates legacy aggregated GPT-5.6 usage from average per-event input', async () => {
    const { calculateBreakdownCost } = await import('../report.js');
    const warnings = new Set<string>();

    const cost = calculateBreakdownCost({
      provider: 'openai',
      product: 'codex',
      channel: 'cli',
      model: 'gpt-5.6-sol',
      project: '/tmp/project',
      eventCount: 2,
      inputTokens: 400_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20_000,
      reasoningOutputTokens: 0,
      costUSD: 0,
    }, warnings);

    expect(cost).toBe(2);
    expect([...warnings]).toEqual(['gpt-5.6-sol 的阶梯价格已按每事件平均输入量估算。']);
  });
});

it('includes Antigravity thinking in billed output exactly once', async () => {
  const { calculateBreakdownCost } = await import('../report.js');
  expect(calculateBreakdownCost({
    provider: 'google', product: 'antigravity', channel: 'cli', model: 'gemini-4-neon-high', project: 'unknown',
    eventCount: 1, inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0,
    outputTokens: 200_000, reasoningOutputTokens: 800_000,
  }, new Set())).toBe(18);
});

it('keeps zeroed legacy replacement buckets out of report activity', async () => {
  const scan = await import('../scan.js');
  const zero = { eventCount: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
  const spy = vi.spyOn(scan, 'scanDates').mockResolvedValue([{
    usageDate: '2026-11-01', totals: zero,
    breakdowns: [{ provider: 'google', product: 'antigravity', channel: 'ide', model: 'unknown', project: 'unknown', ...zero }],
  }]);
  try {
    const { buildLocalReport } = await import('../report.js');
    const report = await buildLocalReport('all', { dates: ['2026-11-01'], tools: ['antigravity'] });
    expect(report.daysWithData).toBe(0);
    expect(report.daily).toEqual([]);
    expect(report.byModel).toEqual([]);
    expect(report.bySource).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});
