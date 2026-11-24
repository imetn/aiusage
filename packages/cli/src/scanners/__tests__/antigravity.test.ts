import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverAntigravityRoots, scanAntigravityDates } from '../antigravity.js';
import { ANTIGRAVITY_MODEL_IDS, isConcreteAntigravityModel, rememberAntigravityModel } from '../antigravity-db.js';

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

  it('returns empty results when no Antigravity metadata exists', async () => {
    const result = await scanAntigravityDates(['2026-02-10'], join(tmpDir, 'missing'));
    expect(result.get('2026-02-10')).toEqual([]);
  });

  it('discovers T3 Code antigravity-acp roots alongside standard Gemini roots', async () => {
    const fakeHome = join(tmpDir, 'home');
    const t3Root = join(fakeHome, '.t3', 'userdata', 'providers', 'antigravity', 'acct-hash-1', 'antigravity-acp');
    await mkdir(t3Root, { recursive: true });

    const roots = await discoverAntigravityRoots(undefined, fakeHome);
    expect(roots).toEqual(expect.arrayContaining([
      join(fakeHome, '.gemini', 'antigravity'),
      join(fakeHome, '.gemini', 'antigravity-cli'),
      join(fakeHome, '.gemini', 'antigravity-ide'),
      join(fakeHome, '.gemini', 'antigravity-backup'),
      join(fakeHome, '.config', 'antigravity'),
      t3Root,
    ]));
  });

  it('maps offline Antigravity numeric model IDs and learns unique concrete models', () => {
    expect(ANTIGRAVITY_MODEL_IDS[1402]).toBe('claude-opus-5-5');
    expect(ANTIGRAVITY_MODEL_IDS[1417]).toBe('gemini-4-argon');
    expect(ANTIGRAVITY_MODEL_IDS[1537]).toBe('gemini-pro-orchestrator-neon');
    expect(isConcreteAntigravityModel('gemini-4-neon')).toBe(true);
    expect(isConcreteAntigravityModel('gemini-3-flash-agent-a')).toBe(false);

    const learned = new Map<number, string | null>();
    rememberAntigravityModel(learned, 9999, 'gemini-4-neon');
    rememberAntigravityModel(learned, 9999, 'gemini-4-neon');
    expect(learned.get(9999)).toBe('gemini-4-neon');
    rememberAntigravityModel(learned, 9999, 'gemini-4-argon');
    expect(learned.get(9999)).toBeNull();
  });
});
