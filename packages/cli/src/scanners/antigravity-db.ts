import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTs } from './utils.js';

// Wire fields and deduplication behavior adapted from VibeCafé/vibe-usage,
// src/parsers/antigravity-db.js and antigravity.js, MIT (2026 VibeCafé).
// Only usage, model, timestamp and workspace metadata are selected.
type Fields = Map<number, Array<number | bigint | Buffer>>;
type SqliteRow = { kind: string; idx: number; value: string };
interface SqliteDatabase {
  prepare(sql: string): { all(): unknown[] };
  exec(sql: string): void;
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDatabase;
}

export interface AntigravityUsage {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  model: string;
  timestamp: Date | null;
  responseId: string;
  providerMessageId: string;
  messageId: string;
  fallbackId: string;
  /** Local provenance for message-scoped IDs and copies without request IDs. */
  identityScope?: string;
  sourceId?: string;
  sourceIds?: string[];
}

export interface AntigravityConversation {
  sessionId: string;
  project: string;
  records: AntigravityUsage[];
}

let sqliteModule: Promise<SqliteModule | null> | undefined;

function varint(buffer: Buffer, offset: number): [bigint, number] {
  let value = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    if (offset >= buffer.length) throw new Error('Truncated protobuf varint');
    const byte = buffer[offset++];
    value |= BigInt(byte & 127) << shift;
    if ((byte & 128) === 0) {
      if (value > 0xffff_ffff_ffff_ffffn) throw new Error('Oversized protobuf integer');
      return [value, offset];
    }
  }
  throw new Error('Oversized protobuf varint');
}

export function decodeAntigravityMessage(buffer: Buffer): Fields {
  const fields: Fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    let rawTag: bigint;
    [rawTag, offset] = varint(buffer, offset);
    if (rawTag > 0xffff_ffffn) throw new Error('Invalid protobuf tag');
    const tag = Number(rawTag);
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field < 1 || field > 536_870_911) throw new Error('Invalid protobuf field');
    let value: number | bigint | Buffer;
    if (wire === 0) {
      [value, offset] = varint(buffer, offset);
      if (value <= BigInt(Number.MAX_SAFE_INTEGER)) value = Number(value);
    } else {
      let length: number;
      if (wire === 2) {
        let rawLength: bigint;
        [rawLength, offset] = varint(buffer, offset);
        if (rawLength > BigInt(buffer.length - offset)) throw new Error('Truncated protobuf field');
        length = Number(rawLength);
      }
      else if (wire === 1) length = 8;
      else if (wire === 5) length = 4;
      else throw new Error('Unsupported protobuf wire type');
      if (length > buffer.length - offset) throw new Error('Truncated protobuf field');
      value = buffer.subarray(offset, offset + length);
      offset += length;
    }
    const values = fields.get(field) ?? [];
    values.push(value);
    fields.set(field, values);
  }
  return fields;
}

function number(fields: Fields, field: number): number | undefined {
  if (fields.get(field)?.some(value => typeof value === 'bigint')) throw new Error('Unsafe protobuf usage integer');
  return fields.get(field)?.find((value): value is number => typeof value === 'number');
}
function bytes(fields: Fields, field: number): Buffer | undefined {
  return fields.get(field)?.find((value): value is Buffer => Buffer.isBuffer(value));
}
function text(fields: Fields, field: number): string {
  return bytes(fields, field)?.toString('utf8') ?? '';
}
function message(fields: Fields, field: number): Fields {
  const buffer = bytes(fields, field);
  return buffer ? decodeAntigravityMessage(buffer) : new Map();
}
function clock(fields: Fields): Date | null {
  const seconds = number(fields, 1);
  return seconds ? parseTs(seconds) : null;
}

export function normalizeAntigravityModel(raw: string): string {
  const value = raw.trim();
  if (!value) return 'unknown';
  const display = /^(Gemini|Claude|GPT[- ]OSS)\s+(.+?)(?:\s+\((Low|Medium|High|XHigh|Max)\))?$/i.exec(value);
  if (!display) return value;
  const family = display[1].toLowerCase().replace(/\s+/g, '-');
  let model = display[2].toLowerCase().replace(/\s+/g, '-');
  if (family === 'claude') model = model.replace(/(\d)\.(\d)/g, '$1-$2');
  return [family, model, display[3]?.toLowerCase()].filter(Boolean).join('-');
}

function unresolvedModel(model: string): boolean {
  return model === 'unknown' || /^antigravity-model-\d+$/.test(model)
    || /orchestrator|^(?:gemini[-_ ])?(?:default|auto)$/i.test(model);
}

function callModel(display: string, response: string, stepModel: string): string {
  const candidates = [display, response, stepModel].filter(value => value && value !== 'unknown');
  // These labels select a workflow/router rather than the billed executor.
  const concrete = candidates.find(value => !unresolvedModel(value));
  return normalizeAntigravityModel(concrete ?? candidates[0] ?? '');
}

function usage(fields: Fields, model: string, timestamp: Date | null, fallbackId: string): AntigravityUsage | null {
  const input = number(fields, 2) ?? 0;
  const cached = number(fields, 5) ?? 0;
  const cacheWrite = number(fields, 4) ?? 0;
  const reportedReasoning = number(fields, 9) ?? 0;
  const visible = number(fields, 10);
  const totalOutput = number(fields, 3) ?? ((visible ?? 0) + reportedReasoning);
  const output = visible === undefined ? Math.max(0, totalOutput - reportedReasoning) : Math.min(visible, totalOutput);
  const reasoning = totalOutput - output;
  if (input + cached + cacheWrite + totalOutput === 0) return null;
  const modelId = number(fields, 1);
  if (model === 'unknown' && modelId) model = `antigravity-model-${modelId}`;
  return {
    input, cached, cacheWrite, output, reasoning, model, timestamp, fallbackId,
    responseId: text(fields, 11), providerMessageId: text(fields, 12), messageId: text(fields, 7),
  };
}

function retries(fields: Fields, field: number, model: string, timestamp: Date | null, fallbackId: string): AntigravityUsage[] {
  const out: AntigravityUsage[] = [];
  for (const [index, buffer] of (fields.get(field) ?? []).entries()) {
    if (!Buffer.isBuffer(buffer)) continue;
    const attempt = usage(message(decodeAntigravityMessage(buffer), 2), model, timestamp, `${fallbackId}:retry:${index}`);
    if (attempt) out.push(attempt);
  }
  return out;
}

function strongKeys(record: AntigravityUsage): string[] {
  return [record.responseId && `response:${record.responseId}`, record.providerMessageId && `provider:${record.providerMessageId}`].filter(Boolean);
}
function keys(record: AntigravityUsage): string[] {
  return [...strongKeys(record),
    ...(record.messageId ? [`message:${record.identityScope ?? ''}:${record.messageId}`] : []),
    ...[...new Set([...(record.sourceIds ?? []), ...(record.sourceId ? [record.sourceId] : [])])]
      .map(source => `source:${source}`)];
}
function score(record: AntigravityUsage): number {
  return record.input + record.cached + record.cacheWrite + record.output + record.reasoning;
}
function richer(left: AntigravityUsage, right: AntigravityUsage): AntigravityUsage {
  const [rich, other] = score(right) > score(left) ? [right, left] : [left, right];
  return { ...rich, timestamp: rich.timestamp ?? other.timestamp,
    model: unresolvedModel(rich.model) && !unresolvedModel(other.model) ? other.model : rich.model,
    responseId: rich.responseId || other.responseId,
    providerMessageId: rich.providerMessageId || other.providerMessageId,
    messageId: rich.messageId || other.messageId,
    sourceIds: [...new Set([
      ...(left.sourceIds ?? []), ...(right.sourceIds ?? []),
      ...(left.sourceId ? [left.sourceId] : []), ...(right.sourceId ? [right.sourceId] : []),
    ])],
  };
}

export function deduplicateAntigravityUsage(records: AntigravityUsage[]): AntigravityUsage[] {
  interface Group { record: AntigravityUsage; keys: Set<string>; responseIds: Set<string> }
  const groups = new Set<Group>();
  const byKey = new Map<string, Set<Group>>();
  for (const record of records) {
    const identity = keys(record);
    if (!identity.length) identity.push(`fallback:${record.fallbackId}`);
    const hits = new Set<Group>();
    const weakHits = new Set<Group>();
    for (const key of identity) {
      for (const group of byKey.get(key) ?? []) {
        // A retry can share a message ID with an earlier attempt but have a new response ID.
        if (key.startsWith('message:') && record.responseId && group.responseIds.size
            && !group.responseIds.has(record.responseId)) continue;
        (key.startsWith('message:') ? weakHits : hits).add(group);
      }
    }
    // A message can contain several billed retries. An ID-less snapshot may
    // join one known attempt but must never bridge those distinct responses.
    if (hits.size) {
      const knownResponses = new Set([...hits].flatMap(group => [...group.responseIds]));
      if (record.responseId) knownResponses.add(record.responseId);
      for (const group of weakHits) {
        if (!group.responseIds.size || [...group.responseIds].some(id => knownResponses.has(id))) hits.add(group);
      }
    } else if (weakHits.size > 1) {
      const exact = [...weakHits].filter(group => {
        const other = group.record;
        return record.input === other.input && record.cached === other.cached
          && record.cacheWrite === other.cacheWrite && record.output === other.output
          && record.reasoning === other.reasoning;
      });
      if (exact.length !== 1) throw new Error('Ambiguous Antigravity message identity');
      hits.add(exact[0]);
    } else {
      for (const group of weakHits) hits.add(group);
    }
    let target = hits.values().next().value as Group | undefined;
    if (!target) {
      target = { record, keys: new Set(), responseIds: new Set() };
      groups.add(target);
    }
    for (const group of hits) {
      if (group === target) continue;
      target.record = richer(target.record, group.record);
      for (const key of group.keys) {
        const owners = byKey.get(key)!;
        owners.delete(group);
        owners.add(target);
        target.keys.add(key);
      }
      for (const responseId of group.responseIds) target.responseIds.add(responseId);
      groups.delete(group);
    }
    target.record = richer(target.record, record);
    if (record.responseId) target.responseIds.add(record.responseId);
    for (const key of identity) {
      const owners = byKey.get(key) ?? new Set();
      owners.add(target);
      byKey.set(key, owners);
      target.keys.add(key);
    }
  }
  return [...groups].map(group => group.record);
}

async function sqliteRows(path: string): Promise<SqliteRow[]> {
  sqliteModule ??= (async () => {
    try {
      const specifier = 'node:sqlite';
      return await import(specifier) as SqliteModule;
    } catch {
      return null;
    }
  })();
  const runtime = await sqliteModule;
  const tableQueries = {
    gen_metadata: "SELECT 'gen' AS kind, idx, hex(data) AS value FROM gen_metadata ORDER BY idx",
    steps: "SELECT 'step' AS kind, idx, hex(metadata) AS value FROM steps WHERE metadata IS NOT NULL ORDER BY idx",
    trajectory_metadata_blob: "SELECT 'workspace' AS kind, 0 AS idx, hex(data) AS value FROM trajectory_metadata_blob LIMIT 1",
  };
  if (runtime) {
    const db = new runtime.DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 2000; BEGIN');
      const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name));
      if (!names.has('steps') && !names.has('gen_metadata')) throw new Error('Unrecognized Antigravity schema');
      return Object.entries(tableQueries).filter(([table]) => names.has(table)).flatMap(([, query]) => db.prepare(query).all() as SqliteRow[]);
    } finally {
      db.close();
    }
  }
  const output = await new Promise<string>((resolve, reject) => execFile('sqlite3', ['-readonly', '-json', path,
    "SELECT name FROM sqlite_master WHERE type='table'"], { encoding: 'utf8', timeout: 5000 },
  (error, stdout) => error ? reject(error) : resolve(stdout)));
  const names = new Set((JSON.parse(output || '[]') as Array<{ name: string }>).map(row => row.name));
  if (!names.has('steps') && !names.has('gen_metadata')) throw new Error('Unrecognized Antigravity schema');
  const queries = Object.entries(tableQueries).filter(([table]) => names.has(table)).map(([, query]) => `SELECT * FROM (${query})`);
  const rows = await new Promise<string>((resolve, reject) => execFile('sqlite3', ['-readonly', '-json', '-cmd', '.timeout 2000', path,
    `BEGIN; ${queries.join(' UNION ALL ')}; ROLLBACK;`],
  { encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024 * 1024 },
  (error, stdout) => error ? reject(error) : resolve(stdout)));
  return JSON.parse(rows || '[]') as SqliteRow[];
}

export async function readAntigravityConversation(path: string): Promise<AntigravityConversation> {
  const rows = await sqliteRows(path);
  // Workspace labels and later rows can change after copying a database. An
  // exact usage-carrier copy keeps its identity independently of either.
  const fingerprints = new Map(rows.filter(row => row.kind !== 'workspace').map(row => [
    `${row.kind}:${row.idx}`, createHash('sha256').update(JSON.stringify(row)).digest('hex'),
  ]));
  const sessionId = basename(path, '.db');
  const withSource = (record: AntigravityUsage): AntigravityUsage => {
    const position = record.fallbackId.slice(sessionId.length + 1);
    const [kind, idx, ...attempt] = position.split(':');
    return { ...record, identityScope: sessionId,
      sourceId: `${fingerprints.get(`${kind}:${idx}`)}:${attempt.join(':')}` };
  };
  const steps = new Map<number, { timestamp: Date | null; model: string; fields: Fields }>();
  let project = 'unknown';
  for (const row of rows) {
    if (!row.value) continue;
    const fields = decodeAntigravityMessage(Buffer.from(row.value, 'hex'));
    if (row.kind === 'step') {
      const modelInfo = message(fields, 24);
      const modelId = number(modelInfo, 1);
      const rawModel = text(modelInfo, 12) || text(modelInfo, 8);
      steps.set(row.idx, { fields, timestamp: clock(message(fields, 1)) ?? clock(message(fields, 8)),
        model: rawModel ? normalizeAntigravityModel(rawModel) : modelId ? `antigravity-model-${modelId}` : 'unknown' });
    } else if (row.kind === 'workspace') {
      const uri = text(message(fields, 1), 1);
      if (uri.startsWith('file://')) {
        try { project = fileURLToPath(uri); } catch { /* Invalid workspace URI stays unknown. */ }
      }
    }
  }
  const records: AntigravityUsage[] = [];
  const generatorSlots = new Map<string, number>();
  for (const row of rows.filter(row => row.kind === 'gen' && row.value)) {
    const chat = message(decodeAntigravityMessage(Buffer.from(row.value, 'hex')), 1);
    const step = steps.get(row.idx);
    const model = callModel(text(chat, 21), text(chat, 19), step?.model ?? 'unknown');
    const timestamp = clock(message(message(chat, 9), 4)) ?? step?.timestamp ?? null;
    const fallback = `${sessionId}:gen:${row.idx}`;
    const record = usage(message(chat, 4), model, timestamp, fallback);
    const attempts = [...(record ? [record] : []), ...retries(chat, 17, model, timestamp, fallback)];
    for (const attempt of attempts) {
      generatorSlots.set(attempt.fallbackId, records.length);
      records.push(withSource(attempt));
    }
  }
  for (const [idx, { fields, model, timestamp }] of steps) {
    const fallback = `${sessionId}:step:${idx}`;
    const current = usage(message(fields, 9), model, timestamp, fallback);
    for (const record of [...(current ? [current] : []), ...retries(fields, 28, model, timestamp, fallback)]) {
      const generatorIndex = generatorSlots.get(record.fallbackId.replace(`${sessionId}:step:`, `${sessionId}:gen:`));
      const generator = generatorIndex === undefined ? undefined : records[generatorIndex];
      // Same-index carriers/attempt slots supply a fallback identity when
      // either snapshot omits request IDs. Keep the more complete snapshot.
      if (generator && (!strongKeys(record).length || !strongKeys(generator).length)) {
        records[generatorIndex!] = richer(generator, withSource(record));
      } else records.push(withSource(record));
    }
  }
  const unique = deduplicateAntigravityUsage(records);
  for (const record of unique) {
    if (!record.timestamp) throw new Error('Antigravity token usage has no per-call timestamp');
  }
  return { sessionId, project, records: unique };
}
