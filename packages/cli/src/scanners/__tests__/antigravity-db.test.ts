import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  decodeAntigravityMessage, deduplicateAntigravityUsage, normalizeAntigravityModel,
  readAntigravityConversation, type AntigravityUsage,
} from '../antigravity-db.js';
import {
  discoverAntigravityProjects, discoverAntigravityUsageDates, scanAntigravityDates,
} from '../antigravity.js';

// All protobuf values, request IDs and filesystem paths in these fixtures are
// fictional. No local messages, account data or authentication is included.
type Field = [number, number | bigint | string | Buffer];
const time = Date.parse('2026-11-23T10:00:00Z') / 1000;
function vint(value: number | bigint): Buffer {
  const bytes: number[] = [];
  let remaining = BigInt(value);
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.from(bytes);
}
function proto(...fields: Field[]): Buffer {
  return Buffer.concat(fields.flatMap(([field, value]) => {
    if (typeof value === 'number' || typeof value === 'bigint') return [vint(field * 8), vint(value)];
    const buffer = typeof value === 'string' ? Buffer.from(value) : value;
    return [vint(field * 8 + 2), vint(buffer.length), buffer];
  }));
}
function gen(value: Buffer, model = 'Gemini 4 Neon (High)', seconds: number | null = time, retry: Buffer[] = []): Buffer {
  return proto([1, proto([4, value], ...(model ? [[21, model] as Field] : []),
    ...(seconds ? [[9, proto([4, proto([1, seconds])])] as Field] : []),
    ...retry.map(item => [17, proto([2, item])] as Field))]);
}
function step(value: Buffer, model = 'Gemini 4 Hydrogen', seconds: number | null = time, retry: Buffer[] = []): Buffer {
  return proto([9, value], ...(model ? [[24, proto([12, model])] as Field] : []),
    ...(seconds ? [[1, proto([1, seconds])] as Field] : []),
    ...retry.map(item => [28, proto([2, item])] as Field));
}
function record(overrides: Partial<AntigravityUsage> = {}): AntigravityUsage {
  return { input: 10, cached: 0, cacheWrite: 0, output: 3, reasoning: 2,
    model: 'gemini-4-neon-high', timestamp: new Date(time * 1000),
    responseId: '', providerMessageId: '', messageId: '', fallbackId: Math.random().toString(), ...overrides };
}
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'aiusage-agy-db-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('node:sqlite');
  await rm(directory, { recursive: true, force: true });
});
async function database(root: string, name: string, generators: Array<[number, Buffer]> = [], steps: Array<[number, Buffer]> = [], workspace = '/fictional/Orchestrator Project'): Promise<string> {
  await mkdir(join(root, 'conversations'), { recursive: true });
  const path = join(root, 'conversations', `${name}.db`);
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB, body BLOB); CREATE TABLE trajectory_metadata_blob (data BLOB)');
    const generatorInsert = db.prepare('INSERT INTO gen_metadata VALUES (?, ?)');
    const stepInsert = db.prepare('INSERT INTO steps VALUES (?, ?, ?)');
    for (const [idx, data] of generators) generatorInsert.run(idx, data);
    for (const [idx, data] of steps) stepInsert.run(idx, data, Buffer.from('private-body-must-not-be-parsed'));
    db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?)').run(proto([1, proto([1, `file://${workspace.replaceAll(' ', '%20')}`])]));
  } finally { db.close(); }
  return path;
}

describe('Antigravity protobuf usage', () => {
  it('normalizes effort display names while preserving canonical and unknown model IDs', () => {
    expect(normalizeAntigravityModel('Gemini 4 Neon (High)')).toBe('gemini-4-neon-high');
    expect(normalizeAntigravityModel('Claude Opus 5.5 (High)')).toBe('claude-opus-5-5-high');
    expect(normalizeAntigravityModel('GPT-OSS 120B (Medium)')).toBe('gpt-oss-120b-medium');
    expect(normalizeAntigravityModel('gemini-4-neon-high')).toBe('gemini-4-neon-high');
    expect(normalizeAntigravityModel('future-provider/native-model')).toBe('future-provider/native-model');
  });

  it.each([
    Buffer.from([0]), Buffer.from([0x80]), Buffer.from([0x0a, 0xff]),
    Buffer.from([0x0a, 0x05, 0x01]), Buffer.from([0x09, 0x01]), Buffer.from([0x0b]),
    Buffer.from([0x08, ...Array(10).fill(0xff)]),
  ])('rejects invalid or truncated protobuf data %#', bytes => {
    expect(() => decodeAntigravityMessage(bytes)).toThrow();
  });

  it('accepts unknown uint64 metadata while rejecting unsafe token counters', async () => {
    const path = await database(directory, 'uint64', [[1, proto([1, proto(
      [4, proto([2, 9524], [3, 5], [11, 'fictional-real-shape'])],
      [9, proto([4, proto([1, time])])], [21, 'gemini-4-hydrogen-low'],
      [200, 0xffff_ffff_ffff_ffffn],
    )])]]);
    expect((await readAntigravityConversation(path)).records).toEqual([
      expect.objectContaining({ model: 'gemini-4-hydrogen-low', input: 9524, output: 5 }),
    ]);
    const bad = await database(directory, 'unsafe-token', [[1, gen(proto([2, 0xffff_ffff_ffff_ffffn]))]]);
    await expect(readAntigravityConversation(bad)).rejects.toThrow('Unsafe protobuf usage integer');
  });

  it('merges generator, step and bridge snapshots without merging distinct billed retries', () => {
    const records = [
      record({ responseId: 'response-a', input: 20 }),
      record({ providerMessageId: 'provider-a', messageId: 'turn-a', input: 22 }),
      record({ responseId: 'response-a', providerMessageId: 'provider-a', input: 21 }),
      record({ responseId: 'response-b', messageId: 'turn-a', input: 2 }),
      record({ messageId: 'turn-a', input: 22 }),
    ];
    const unique = deduplicateAntigravityUsage(records);
    expect(unique).toHaveLength(2);
    expect(unique.map(item => item.input).sort((a, b) => a - b)).toEqual([2, 22]);
  });

  it('scopes message-only IDs to their conversation and fails ambiguous retry bridges', () => {
    expect(deduplicateAntigravityUsage([
      record({ messageId: 'turn-1', identityScope: 'session-a' }),
      record({ messageId: 'turn-1', identityScope: 'session-b' }),
    ])).toHaveLength(2);
    expect(() => deduplicateAntigravityUsage([
      record({ messageId: 'turn-1', responseId: 'a' }),
      record({ messageId: 'turn-1', responseId: 'b' }),
      record({ messageId: 'turn-1' }),
    ])).toThrow('Ambiguous');
  });

  it.each(['unknown', 'antigravity-model-98765', 'gemini-pro-orchestrator', 'gemini-default'])(
    'fills a richer %s snapshot with a concrete model from the same request', model => {
      const unique = deduplicateAntigravityUsage([
        record({ responseId: 'same-request', model, input: 100 }),
        record({ responseId: 'same-request', model: 'gemini-4-hydrogen-low', input: 5 }),
      ]);
      expect(unique).toEqual([expect.objectContaining({ input: 100, model: 'gemini-4-hydrogen-low' })]);
    },
  );
});

describe('Antigravity SQLite conversations', () => {
  it('counts uncached/cache/write once and splits visible output from reasoning', async () => {
    const usage = proto([2, 100], [3, 30], [4, 20], [5, 60], [9, 12], [10, 18], [11, 'r-main']);
    await database(directory, 'same-session', [[1, gen(usage)]], [[1, step(usage, 'Gemini 4 Neon (High)', null)]]);
    const [row] = (await scanAntigravityDates(['2026-11-23'], directory)).get('2026-11-23')!;
    expect(row).toMatchObject({ provider: 'google', model: 'gemini-4-neon-high', channel: 'ide',
      eventCount: 1, sessionCount: 1, inputTokens: 100, cachedInputTokens: 60,
      cacheWriteTokens: 20, cacheWrite5mTokens: 20, outputTokens: 18, reasoningOutputTokens: 12,
      project: '/fictional/Orchestrator Project', projectDisplay: 'Orchestrator Project' });
    expect(row.inputTokens + row.cachedInputTokens + row.cacheWriteTokens + row.outputTokens + row.reasoningOutputTokens).toBe(210);
    expect(await discoverAntigravityProjects(directory)).toEqual(['/fictional/Orchestrator Project']);
  });

  it('applies project aliases while retaining the original project path', async () => {
    await database(directory, 'alias', [[1, gen(proto([2, 5], [3, 2], [11, 'aliased-call']))]]);
    const rows = (await scanAntigravityDates(['2026-11-23'], directory, {
      '/fictional/Orchestrator Project': 'Workspace Alias',
    })).get('2026-11-23')!;
    expect(rows).toEqual([expect.objectContaining({
      project: '/fictional/Orchestrator Project', projectDisplay: 'Orchestrator Project', projectAlias: 'Workspace Alias',
    })]);
  });

  it('reads step-only Orchestrator planners and executors independently across days', async () => {
    const root = join(directory, 'antigravity-cli');
    await database(root, 'mixed', [], [
      [0, step(proto([2, 11], [3, 8], [9, 3], [11, 'planner']), 'Gemini 4 Neon (High)', time - 86400)],
      [1, step(proto([2, 6], [3, 4], [11, 'executor']), 'Gemini 4 Hydrogen', time)],
      [2, step(proto([2, 12], [3, 5], [11, 'claude']), 'Claude Opus 5.5 (High)', time)],
      [3, step(proto([1, 98765], [2, 7], [3, 2], [11, 'unknown']), '', time)],
      [4, step(proto([2, 9], [3, 2], [11, 'oss']), 'GPT-OSS 120B (Medium)', time)],
    ]);
    const results = await scanAntigravityDates(['2026-11-22', '2026-11-23'], root);
    expect(results.get('2026-11-22')).toEqual([expect.objectContaining({ model: 'gemini-4-neon-high', channel: 'cli', inputTokens: 11, outputTokens: 5, reasoningOutputTokens: 3 })]);
    expect(results.get('2026-11-23')).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'gemini-4-hydrogen', provider: 'google', inputTokens: 6 }),
      expect.objectContaining({ model: 'claude-opus-5-5-high', provider: 'anthropic', inputTokens: 12 }),
      expect.objectContaining({ model: 'antigravity-model-98765', inputTokens: 7 }),
      expect.objectContaining({ model: 'gpt-oss-120b-medium', inputTokens: 9 }),
    ]));
    expect(await discoverAntigravityUsageDates(root)).toEqual(['2026-11-22', '2026-11-23']);
  });

  it('uses same-index step clocks, retains step-only calls in mixed stores and counts retries once', async () => {
    const main = proto([2, 20], [3, 10], [9, 4], [11, 'response-main'], [7, 'turn-main']);
    const retry = proto([2, 3], [3, 2], [11, 'response-retry'], [7, 'turn-main']);
    await database(directory, 'retries', [[1, gen(main, '', null, [retry])]], [
      [1, step(main, 'Gemini 4 Neon (High)', time, [retry])],
      [2, step(proto([2, 9], [3, 4]), 'Gemini 4 Hydrogen', time)],
    ]);
    const rows = (await scanAntigravityDates(['2026-11-23'], directory)).get('2026-11-23')!;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'gemini-4-neon-high', eventCount: 2, inputTokens: 23, outputTokens: 8, reasoningOutputTokens: 4 }),
      expect.objectContaining({ model: 'gemini-4-hydrogen', eventCount: 1, inputTokens: 9 }),
    ]));
  });

  it('uses actual executor models beneath Orchestrator labels but keeps concrete display efforts over generic aliases', async () => {
    const orchestrator = proto([1, proto([4, proto([2, 7], [3, 2], [11, 'executor-hydrogen'])],
      [21, 'Gemini Pro Orchestrator'], [19, 'gemini-4-hydrogen-low'])]);
    const alias = proto([1, proto([4, proto([2, 11], [3, 4], [11, 'display-neon'])],
      [21, 'Gemini 4 Neon (High)'], [19, 'gemini-default'])]);
    const stepExecutor = proto([1, proto([4, proto([2, 3], [3, 2], [11, 'executor-carbon'])],
      [21, 'Gemini Pro Orchestrator'], [19, 'gemini-default'])]);
    await database(directory, 'selectors', [[1, orchestrator], [2, alias], [3, stepExecutor]], [
      [1, step(proto(), 'Gemini 4 Hydrogen (Low)')],
      [2, step(proto(), 'Gemini 4 Neon (High)')],
      [3, step(proto(), 'Gemini 4 Carbon (High)')],
    ]);
    const rows = (await scanAntigravityDates(['2026-11-23'], directory)).get('2026-11-23')!;
    expect(rows.map(row => row.model).sort()).toEqual(['gemini-4-carbon-high', 'gemini-4-hydrogen-low', 'gemini-4-neon-high']);
  });

  it('keeps enriched anonymous step snapshots and their original copy identities', async () => {
    const original = await database(directory, 'old-copy', [[1, gen(proto([2, 7], [3, 2]))]]);
    await copyFile(original, join(directory, 'conversations', 'live-copy.db'));
    const live = new DatabaseSync(join(directory, 'conversations', 'live-copy.db'));
    live.prepare('INSERT INTO steps VALUES (?, ?, NULL)').run(1, step(proto([2, 7], [3, 2], [5, 11]), 'Gemini 4 Neon (High)'));
    live.close();
    const rows = (await scanAntigravityDates(['2026-11-23'], directory)).get('2026-11-23')!;
    expect(rows).toEqual([expect.objectContaining({ eventCount: 1, inputTokens: 7, cachedInputTokens: 11, outputTokens: 2 })]);
  });

  it('deduplicates a renamed database copy even when the call has no request identifiers', async () => {
    const path = await database(directory, 'original', [[1, gen(proto([2, 9], [3, 4]))]]);
    await copyFile(path, join(directory, 'conversations', 'copied.db'));
    const [row] = (await scanAntigravityDates(['2026-11-23'], directory)).get('2026-11-23')!;
    expect(row).toMatchObject({ eventCount: 1, sessionCount: 1, inputTokens: 9, outputTokens: 4 });
    const copied = new DatabaseSync(join(directory, 'conversations', 'copied.db'));
    copied.exec('DELETE FROM trajectory_metadata_blob');
    copied.prepare('INSERT INTO trajectory_metadata_blob VALUES (?)').run(proto([1, proto([1, 'file:///fictional/other-workspace'])]));
    copied.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(2, gen(proto([2, 5], [3, 2]), 'Gemini 4 Neon (High)', time + 60));
    copied.close();
    const totals = (await scanAntigravityDates(['2026-11-23'], directory)).get('2026-11-23')!;
    expect(totals.reduce((sum, item) => sum + item.eventCount, 0)).toBe(2);
    expect(totals.reduce((sum, item) => sum + item.inputTokens, 0)).toBe(14);
  });

  it('retains remaining legacy sessions and emits only proven replacement tombstones', async () => {
    const usage = gen(proto([2, 5], [3, 2], [11, 'known-call']));
    await database(directory, 'known', [[1, usage]]);
    await mkdir(join(directory, 'brain', 'known'), { recursive: true });
    await writeFile(join(directory, 'brain', 'known', 'task.md.metadata.json'), JSON.stringify({ updatedAt: '2026-11-21T10:00:00Z' }));
    let results = await scanAntigravityDates(['2026-11-21', '2026-11-23'], directory);
    expect(results.get('2026-11-21')).toEqual([expect.objectContaining({ model: 'unknown', eventCount: 0, inputTokens: 0 })]);
    expect(results.get('2026-11-23')).toHaveLength(1);
    expect(await discoverAntigravityUsageDates(directory)).toEqual(['2026-11-21', '2026-11-23']);
    await mkdir(join(directory, 'brain', 'unrecoverable-legacy'), { recursive: true });
    await writeFile(join(directory, 'brain', 'unrecoverable-legacy', 'task.md.metadata.json'), JSON.stringify({ updatedAt: '2026-11-21T11:00:00Z' }));
    results = await scanAntigravityDates(['2026-11-21'], directory);
    expect(results.get('2026-11-21')).toEqual([expect.objectContaining({ model: 'unknown', eventCount: 1 })]);
  });

  it('sees uncheckpointed WAL usage without changing source database or WAL contents', async () => {
    const path = await database(directory, 'live');
    const writer = new DatabaseSync(path);
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0');
    writer.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, gen(proto([2, 15], [3, 6], [11, 'wal-call'])));
    try {
      const before = await Promise.all([readFile(path), readFile(`${path}-wal`)]);
      const result = await readAntigravityConversation(path);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].input).toBe(15);
      expect(await Promise.all([readFile(path), readFile(`${path}-wal`)])).toEqual(before);
    } finally { writer.close(); }
  });

  it('fails closed for malformed blobs, unsupported schemas, missing clocks and locked databases', async () => {
    await database(directory, 'bad-blob', [[1, Buffer.from([0x0a, 0xff])]]);
    await expect(scanAntigravityDates(['2026-11-23'], directory)).rejects.toThrow('preserve previous uploads');
    await rm(join(directory, 'conversations', 'bad-blob.db'));
    const missingTime = await database(directory, 'missing-clock', [[1, gen(proto([2, 5]), '', null)]]);
    await expect(readAntigravityConversation(missingTime)).rejects.toThrow('per-call timestamp');
    const unsupported = join(directory, 'unsupported.db');
    const unsupportedDb = new DatabaseSync(unsupported);
    unsupportedDb.exec('CREATE TABLE unsupported (data BLOB)');
    unsupportedDb.close();
    await expect(readAntigravityConversation(unsupported)).rejects.toThrow('Unrecognized');
    const path = await database(directory, 'locked');
    const writer = new DatabaseSync(path);
    writer.exec('BEGIN EXCLUSIVE');
    try { await expect(readAntigravityConversation(path)).rejects.toThrow('locked'); }
    finally { writer.exec('ROLLBACK'); writer.close(); }
  });

  it('warns when only opaque legacy conversation files exist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mkdir(join(directory, 'conversations'), { recursive: true });
    await writeFile(join(directory, 'conversations', 'unreadable.pb'), 'opaque-fixture');
    expect((await scanAntigravityDates(['2026-11-23'], directory)).get('2026-11-23')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no supported offline Token data'));
  });

  it('fails closed instead of clearing historical activity when existing legacy metadata is corrupt', async () => {
    await mkdir(join(directory, 'brain', 'corrupt'), { recursive: true });
    await writeFile(join(directory, 'brain', 'corrupt', 'task.md.metadata.json'), '{invalid-fixture');
    await expect(scanAntigravityDates(['2026-11-23'], directory)).rejects.toThrow('preserve previous uploads');
  });

  it('uses the readonly sqlite3 fallback when node:sqlite is unavailable', async () => {
    const path = await database(directory, 'sqlite3', [[1, gen(proto([2, 19], [3, 5], [11, 'fallback-call']))]]);
    vi.resetModules();
    let attemptedNativeImport = false;
    vi.doMock('node:sqlite', () => {
      attemptedNativeImport = true;
      throw new Error('Node 18 does not provide node:sqlite');
    });
    const fallback = await import('../antigravity-db.js');
    const result = await fallback.readAntigravityConversation(path);
    expect(result.records).toEqual([expect.objectContaining({ input: 19, output: 5 })]);
    expect(attemptedNativeImport).toBe(true);
  });
});
