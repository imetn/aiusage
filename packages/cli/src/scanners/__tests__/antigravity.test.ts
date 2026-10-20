import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanAntigravityDates } from '../antigravity.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `aiusage-antigravity-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function writeJsonl(path: string, values: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, values.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n'));
}

describe('scanAntigravityDates', () => {
  it('counts one event per Antigravity session ID across brain and browser metadata', async () => {
    const baseDir = join(tmpDir, 'antigravity');

    await writeJson(
      join(baseDir, 'brain', 'session-a', 'task.md.metadata.json'),
      {
        artifactType: 'ARTIFACT_TYPE_TASK',
        updatedAt: '2026-02-10T15:55:04.375550Z',
      },
    );

    await writeJson(
      join(baseDir, 'browser_recordings', 'session-a', 'metadata.json'),
      {
        highlights: [
          {
            start_time: '2026-02-10T16:00:38.549354Z',
            end_time: '2026-02-10T16:00:40.594582Z',
          },
        ],
      },
    );

    await writeJson(
      join(baseDir, 'browser_recordings', 'session-b', 'metadata.json'),
      {
        highlights: [
          {
            start_time: '2026-02-10T08:00:00.000Z',
            end_time: '2026-02-10T08:00:05.000Z',
          },
        ],
      },
    );

    await writeJson(
      join(baseDir, 'brain', 'session-c', 'task.md.metadata.json'),
      {
        artifactType: 'ARTIFACT_TYPE_TASK',
        updatedAt: '2026-02-11T09:00:00.000Z',
      },
    );

    const result = await scanAntigravityDates(['2026-02-10', '2026-02-11'], baseDir);

    expect(result.get('2026-02-10')).toEqual([
      {
        provider: 'google',
        product: 'antigravity',
        channel: 'ide',
        model: 'unknown',
        project: 'unknown',
        eventCount: 2,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
    ]);

    expect(result.get('2026-02-11')).toEqual([
      {
        provider: 'google',
        product: 'antigravity',
        channel: 'ide',
        model: 'unknown',
        project: 'unknown',
        eventCount: 1,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
    ]);
  });

  it('counts user inputs from transcripts and does not duplicate session metadata', async () => {
    const baseDir = join(tmpDir, 'antigravity');
    const transcript = join(baseDir, 'brain', 'session-a', '.system_generated', 'logs', 'transcript.jsonl');

    await writeJson(join(baseDir, 'brain', 'session-a', 'task.md.metadata.json'), {
      updatedAt: '2026-02-10T18:00:00.000Z',
    });
    await writeJsonl(transcript, [
      { type: 'USER_INPUT', status: 'DONE', created_at: '2026-02-10T08:00:00.000Z' },
      '{ malformed',
      { type: 'TOOL_CALL', status: 'DONE', created_at: '2026-02-10T08:01:00.000Z' },
      { type: 'USER_INPUT', status: 'DONE', created_at: '2026-02-10T09:00:00.000Z' },
      { type: 'USER_INPUT', status: 'ERROR', created_at: '2026-02-10T10:00:00.000Z' },
      { type: 'USER_INPUT', status: 'DONE', created_at: '2026-02-11T09:00:00.000Z' },
    ]);

    const result = await scanAntigravityDates(['2026-02-10', '2026-02-11'], baseDir);

    expect(result.get('2026-02-10')?.[0]?.eventCount).toBe(2);
    expect(result.get('2026-02-11')?.[0]?.eventCount).toBe(1);
  });

  it('returns empty results when no Antigravity metadata exists', async () => {
    const result = await scanAntigravityDates(['2026-02-10'], join(tmpDir, 'missing'));
    expect(result.get('2026-02-10')).toEqual([]);
  });
});
