import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverClaudeProjectDirs, scanClaudeDates } from '../claude.js';

// ─── helpers ────────────────────────────────────────────────────────────────

async function writeJsonl(dir: string, filename: string, lines: object[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), lines.map(l => JSON.stringify(l)).join('\n'));
}

function claudeRecord(opts: {
  timestamp: string;
  requestId: string;
  model: string;
  cwd?: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}): object {
  return {
    timestamp: opts.timestamp,
    requestId: opts.requestId,
    cwd: opts.cwd ?? '/Users/test/project',
    message: {
      id: `msg_${opts.requestId}`,
      model: opts.model,
      usage: {
        input_tokens: opts.inputTokens,
        output_tokens: opts.outputTokens,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: (opts.cacheWrite5m ?? 0) + (opts.cacheWrite1h ?? 0),
        cache_creation: {
          ephemeral_5m_input_tokens: opts.cacheWrite5m ?? 0,
          ephemeral_1h_input_tokens: opts.cacheWrite1h ?? 0,
        },
      },
    },
  };
}

let tmpDir: string;
// baseDirs that getClaudeProjectDirs() will use: tmpDir/projects
// stats-cache lives at: tmpDir/stats-cache.json

beforeEach(async () => {
  tmpDir = join(tmpdir(), `aiusage-claude-test-${Date.now()}`);
  await mkdir(join(tmpDir, 'projects'), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── JSONL scanning ──────────────────────────────────────────────────────────

describe('JSONL scanning', () => {
  it('returns data for a date that has JSONL records', async () => {
    const projectDir = join(tmpDir, 'projects', '-Users-test-project');
    await writeJsonl(projectDir, 'session.jsonl', [
      claudeRecord({
        timestamp: '2026-01-15T10:00:00.000Z',
        requestId: 'req_001',
        model: 'claude-opus-4-5-20251101',
        inputTokens: 1000,
        outputTokens: 200,
        cacheRead: 5000,
        cacheWrite5m: 3000,
      }),
    ]);

    const result = await scanClaudeDates(['2026-01-15'], join(tmpDir, 'projects'));
    const breakdowns = result.get('2026-01-15')!;
    expect(breakdowns).toHaveLength(1);
    const b = breakdowns[0];
    expect(b.model).toBe('claude-opus-4-5');
    expect(b.inputTokens).toBe(1000);
    expect(b.outputTokens).toBe(200);
    expect(b.cachedInputTokens).toBe(5000);
    expect(b.cacheWriteTokens).toBe(3000);
  });

  it('deduplicates repeated records with the same messageId+requestId', async () => {
    const projectDir = join(tmpDir, 'projects', '-Users-test-project');
    // Same messageId+requestId in 3 files (session replay pattern): identical token counts
    await writeJsonl(projectDir, 'session1.jsonl', [
      claudeRecord({ timestamp: '2026-01-15T10:00:00.000Z', requestId: 'req_001', model: 'claude-sonnet-4-5-20250929', inputTokens: 500, outputTokens: 200 }),
    ]);
    await writeJsonl(projectDir, 'session2.jsonl', [
      claudeRecord({ timestamp: '2026-01-15T10:00:00.000Z', requestId: 'req_001', model: 'claude-sonnet-4-5-20250929', inputTokens: 500, outputTokens: 200 }),
    ]);
    await writeJsonl(projectDir, 'session3.jsonl', [
      claudeRecord({ timestamp: '2026-01-15T10:00:00.000Z', requestId: 'req_001', model: 'claude-sonnet-4-5-20250929', inputTokens: 500, outputTokens: 200 }),
    ]);

    const result = await scanClaudeDates(['2026-01-15'], join(tmpDir, 'projects'));
    const [b] = result.get('2026-01-15')!;
    expect(b.outputTokens).toBe(200); // counted once, not 3×
    expect(b.inputTokens).toBe(500);
    expect(b.eventCount).toBe(1);     // single event despite 3 files
  });

  it('缺少 requestId 时按 message.id 去重，并合并流式快照的字段最大值', async () => {
    const projectDir = join(tmpDir, 'projects', '-Users-test-project');
    await writeJsonl(projectDir, 'session.jsonl', [
      {
        type: 'assistant', timestamp: '2026-01-15T10:00:00.000Z', cwd: '/Users/test/project',
        message: { id: 'msg_stream', model: 'claude-opus-4-8', usage: {
          input_tokens: 100, cache_read_input_tokens: 300, output_tokens: 20,
        } },
      },
      {
        type: 'assistant', timestamp: '2026-01-15T10:00:01.000Z', cwd: '/Users/test/project',
        message: { id: 'msg_stream', model: 'claude-opus-4-8', usage: {
          input_tokens: 150, cache_read_input_tokens: 250, output_tokens: 40,
        } },
      },
    ]);

    const [b] = (await scanClaudeDates(['2026-01-15'], join(tmpDir, 'projects'))).get('2026-01-15')!;
    expect(b).toEqual(expect.objectContaining({
      eventCount: 1,
      inputTokens: 150,
      cachedInputTokens: 300,
      outputTokens: 40,
    }));
  });

  it('缓存写入总量使用权威字段，并随流式快照更新明细', async () => {
    const projectDir = join(tmpDir, 'projects', '-Users-test-project');
    await writeJsonl(projectDir, 'session.jsonl', [
      {
        type: 'assistant', timestamp: '2026-01-15T10:00:00.000Z', cwd: '/Users/test/project',
        message: { id: 'msg_cache', model: 'claude-opus-4-8', usage: {
          input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 30 },
        } },
      },
      {
        type: 'assistant', timestamp: '2026-01-15T10:00:01.000Z', cwd: '/Users/test/project',
        message: { id: 'msg_cache', model: 'claude-opus-4-8', usage: {
          input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 120,
          cache_creation: { ephemeral_5m_input_tokens: 70, ephemeral_1h_input_tokens: 50 },
        } },
      },
    ]);

    const [b] = (await scanClaudeDates(['2026-01-15'], join(tmpDir, 'projects'))).get('2026-01-15')!;
    expect(b).toEqual(expect.objectContaining({
      eventCount: 1,
      cacheWriteTokens: 120,
      cacheWrite5mTokens: 70,
      cacheWrite1hTokens: 50,
    }));
  });

  it('从显式字段或模型前缀识别兼容模型供应商', async () => {
    const projectDir = join(tmpDir, 'projects', '-Users-test-project');
    await writeJsonl(projectDir, 'session.jsonl', [
      {
        type: 'assistant', timestamp: '2026-01-15T10:00:00.000Z', cwd: '/Users/test/project',
        message: { id: 'msg_custom', model: 'model_api/experimental_0630', usage: {
          input_tokens: 100, output_tokens: 20,
        } },
      },
    ]);

    const [b] = (await scanClaudeDates(['2026-01-15'], join(tmpDir, 'projects'))).get('2026-01-15')!;
    expect(b.provider).toBe('model_api');
  });

  it('去除 group/factory/grok 等路由前缀并按底层模型 ID 推断供应商', async () => {
    const projectDir = join(tmpDir, 'projects', '-Users-test-project');
    await writeJsonl(projectDir, 'session.jsonl', [
      claudeRecord({ timestamp: '2026-11-17T10:00:00.000Z', requestId: 'req_1', model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 50 }),
      claudeRecord({ timestamp: '2026-11-17T10:01:00.000Z', requestId: 'req_2', model: 'group/auto-claude-opus-5-5', inputTokens: 200, outputTokens: 70 }),
      claudeRecord({ timestamp: '2026-11-17T10:02:00.000Z', requestId: 'req_3', model: 'group/auto-claude-fable-5-2:high', inputTokens: 300, outputTokens: 80 }),
      claudeRecord({ timestamp: '2026-11-17T10:03:00.000Z', requestId: 'req_4', model: 'factory/claude-fable-5.2', inputTokens: 400, outputTokens: 90 }),
      claudeRecord({ timestamp: '2026-11-17T10:04:00.000Z', requestId: 'req_5', model: 'group/auto-grok-4-7', inputTokens: 500, outputTokens: 100 }),
      claudeRecord({ timestamp: '2026-11-17T10:05:00.000Z', requestId: 'req_6', model: 'grok/grok-4.7', inputTokens: 600, outputTokens: 110 }),
      claudeRecord({ timestamp: '2026-11-17T10:06:00.000Z', requestId: 'req_7', model: 'group/auto-deepseek-v4-1-flash', inputTokens: 700, outputTokens: 120 }),
      claudeRecord({ timestamp: '2026-11-17T10:07:00.000Z', requestId: 'req_8', model: 'group/unknown-lab-model', inputTokens: 800, outputTokens: 130 }),
    ]);

    const breakdowns = (await scanClaudeDates(['2026-11-17'], join(tmpDir, 'projects'))).get('2026-11-17')!;
    const byKey = new Map(breakdowns.map(b => [`${b.provider}/${b.model}`, b]));

    expect(byKey.get('anthropic/claude-opus-5-5')).toEqual(expect.objectContaining({
      eventCount: 2, inputTokens: 300, outputTokens: 120,
    }));
    expect(byKey.get('anthropic/claude-fable-5-2')).toEqual(expect.objectContaining({
      eventCount: 2, inputTokens: 700, outputTokens: 170,
    }));
    expect(byKey.get('xai/grok-4.7')).toEqual(expect.objectContaining({
      eventCount: 2, inputTokens: 1100, outputTokens: 210,
    }));
    expect(byKey.get('deepseek/deepseek-v4.1-flash')).toEqual(expect.objectContaining({
      eventCount: 1, inputTokens: 700, outputTokens: 120,
    }));
    expect(byKey.get('unknown/unknown-lab-model')).toEqual(expect.objectContaining({
      eventCount: 1, inputTokens: 800, outputTokens: 130,
    }));
    expect([...byKey.keys()].some(k => k.startsWith('group/') || k.startsWith('factory/') || k.startsWith('grok/'))).toBe(false);
  });

  it('跨文件去重同一 message.id 的有/无 requestId 副本，同时保留同 message.id 不同 requestId', async () => {
    const dirA = join(tmpDir, 'projects', '-Users-test-a');
    const dirB = join(tmpDir, 'projects', '-Users-test-b');
    await writeJsonl(dirA, 'a.jsonl', [
      {
        type: 'assistant', timestamp: '2026-11-23T11:30:36.000Z', cwd: '/Users/test/a',
        requestId: 'req_1',
        message: { id: 'msg_shared', model: 'claude-fable-5-2', usage: { input_tokens: 10, output_tokens: 600 } },
      },
      {
        type: 'assistant', timestamp: '2026-11-23T11:31:00.000Z', cwd: '/Users/test/a',
        message: { id: 'msg_reverse', model: 'claude-fable-5-2', usage: { input_tokens: 20, output_tokens: 400 } },
      },
    ]);
    await writeJsonl(dirB, 'b.jsonl', [
      {
        type: 'assistant', timestamp: '2026-11-23T11:30:36.500Z', cwd: '/Users/test/b',
        message: { id: 'msg_shared', model: 'claude-fable-5-2', usage: { input_tokens: 10, output_tokens: 600 } },
      },
      {
        type: 'assistant', timestamp: '2026-11-23T11:31:00.500Z', cwd: '/Users/test/b',
        requestId: 'req_reverse',
        message: { id: 'msg_reverse', model: 'claude-fable-5-2', usage: { input_tokens: 20, output_tokens: 400 } },
      },
      {
        type: 'assistant', timestamp: '2026-11-23T11:32:00.000Z', cwd: '/Users/test/b',
        requestId: 'req_2',
        message: { id: 'msg_shared', model: 'claude-fable-5-2', usage: { input_tokens: 5, output_tokens: 100 } },
      },
    ]);

    const breakdowns = (await scanClaudeDates(['2026-11-23'], join(tmpDir, 'projects'))).get('2026-11-23')!;
    const totalEvents = breakdowns.reduce((s, b) => s + b.eventCount, 0);
    const totalOutput = breakdowns.reduce((s, b) => s + b.outputTokens, 0);
    expect(totalEvents).toBe(3); // msg_shared:req_1 + msg_reverse + msg_shared:req_2
    expect(totalOutput).toBe(1100);
  });

  it('统计 usage.iterations 中的 advisor_message 嵌套模型用量并正确去重', async () => {
    const projectDir = join(tmpDir, 'projects', '-Users-test-project');
    const recordWithAdvisor = {
      type: 'assistant',
      timestamp: '2026-11-17T12:00:00.000Z',
      requestId: 'req_adv_1',
      cwd: '/Users/test/project',
      message: {
        id: 'msg_adv_1',
        model: 'claude-sonnet-5-5',
        usage: {
          input_tokens: 1_000,
          output_tokens: 200,
          cache_read_input_tokens: 5_000,
          iterations: [
            {
              type: 'message',
              input_tokens: 1_000,
              output_tokens: 200,
            },
            {
              type: 'advisor_message',
              model: 'claude-opus-5-5',
              input_tokens: 2_000,
              output_tokens: 400,
              cache_read_input_tokens: 3_000,
              cache_creation_input_tokens: 500,
            },
          ],
        },
      },
    };
    await writeJsonl(projectDir, 'session.jsonl', [recordWithAdvisor, recordWithAdvisor]);

    const breakdowns = (await scanClaudeDates(['2026-11-17'], join(tmpDir, 'projects'))).get('2026-11-17')!;
    const byModel = new Map(breakdowns.map((b) => [b.model, b]));
    expect(byModel.get('claude-sonnet-5-5')).toMatchObject({
      eventCount: 1,
      inputTokens: 1_000,
      cachedInputTokens: 5_000,
      outputTokens: 200,
    });
    expect(byModel.get('claude-opus-5-5')).toMatchObject({
      eventCount: 1,
      inputTokens: 2_000,
      cachedInputTokens: 3_000,
      cacheWriteTokens: 500,
      outputTokens: 400,
    });
  });

  it('returns empty array for a date with no JSONL data and no stats-cache', async () => {
    const result = await scanClaudeDates(['2025-11-01'], join(tmpDir, 'projects'));
    expect(result.get('2025-11-01')).toEqual([]);
  });
});

describe('Claude data directory discovery', () => {
  it('includes default, configured, multi-profile, and Desktop Cowork roots', async () => {
    const homeDir = join(tmpDir, 'home');
    const configuredRoot = join(tmpDir, 'configured-claude');
    const profileProjects = join(homeDir, '.claude-work', 'projects');
    const coworkProjects = join(
      homeDir,
      'Library',
      'Application Support',
      'Claude',
      'local-agent-mode-sessions',
      'session-a',
      'run-a',
      'local-a',
      '.claude',
      'projects',
    );
    await Promise.all([
      mkdir(join(homeDir, '.claude', 'projects'), { recursive: true }),
      mkdir(profileProjects, { recursive: true }),
      mkdir(join(configuredRoot, 'projects'), { recursive: true }),
      mkdir(coworkProjects, { recursive: true }),
    ]);

    const dirs = await discoverClaudeProjectDirs(undefined, {
      homeDir,
      platform: 'darwin',
      env: { CLAUDE_CONFIG_DIR: configuredRoot },
    });

    expect(dirs).toEqual(expect.arrayContaining([
      join(homeDir, '.config', 'claude', 'projects'),
      join(homeDir, '.claude', 'projects'),
      join(configuredRoot, 'projects'),
      profileProjects,
      coworkProjects,
    ]));
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe('stats-cache safety', () => {
  it('does not fabricate per-model input/output from aggregate stats-cache data', async () => {
    await writeFile(join(tmpDir, 'stats-cache.json'), JSON.stringify({
      dailyModelTokens: [
        { date: '2025-12-25', tokensByModel: { 'claude-opus-4-5': 500_000 } },
      ],
    }));

    const result = await scanClaudeDates(['2025-12-25'], join(tmpDir, 'projects'));
    expect(result.get('2025-12-25')).toEqual([]);
  });
});
