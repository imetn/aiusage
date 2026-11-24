import { readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { IngestBreakdown } from '@aiusage/shared';
import {
  parseTs, dateKey, initDateMap, accumulate, finalize, inferProviderFromModel, resolveProjectFields,
} from './utils.js';
import {
  ANTIGRAVITY_MODEL_IDS,
  deduplicateAntigravityUsage,
  isConcreteAntigravityModel,
  readAntigravityConversation,
  rememberAntigravityModel,
  type AntigravityUsage,
} from './antigravity-db.js';

interface AntigravityBrowserMetadata {
  highlights?: Array<{ start_time?: string; end_time?: string }>;
}
interface AntigravityArtifactMetadata { updatedAt?: string }
interface UsageContext { project: string; sessionId: string; channel: 'cli' | 'ide' }
interface AntigravityData {
  records: AntigravityUsage[];
  contexts: Map<string, UsageContext>;
  legacy: Map<string, { timestamp: Date; channel: 'cli' | 'ide' }>;
  replacedLegacy: Array<{ timestamp: Date; channel: 'cli' | 'ide' }>;
}

async function entries(path: string) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Antigravity history directory could not be read; sync was stopped to preserve previous uploads', { cause: error });
  }
}

export async function discoverAntigravityRoots(
  baseDir?: string,
  homeDir = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (baseDir) return [baseDir];
  const configured = env.ANTIGRAVITY_DATA_DIR?.split(',').map(v => v.trim()).filter(Boolean) ?? [];
  const candidates = configured.length > 0
    ? configured
    : [
        ...['antigravity', 'antigravity-cli', 'antigravity-ide', 'antigravity-backup'].map(name => join(homeDir, '.gemini', name)),
        join(homeDir, '.config', 'antigravity'),
      ];
  const t3ProvidersDir = join(homeDir, '.t3', 'userdata', 'providers', 'antigravity');
  try {
    const providerEntries = (await readdir(t3ProvidersDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of providerEntries) {
      candidates.push(join(t3ProvidersDir, entry.name, 'antigravity-acp'));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Antigravity history directory could not be read; sync was stopped to preserve previous uploads', { cause: error });
    }
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of candidates) {
    let canonical = candidate;
    try { canonical = await realpath(candidate); } catch { /* Missing roots are skipped later. */ }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push(candidate);
  }
  return unique;
}

async function readAntigravityData(baseDir?: string): Promise<AntigravityData> {
  const roots = await discoverAntigravityRoots(baseDir);
  const records: AntigravityUsage[] = [];
  const contexts = new Map<string, UsageContext>();
  const legacy = new Map<string, { timestamp: Date; channel: 'cli' | 'ide' }>();
  const sessionsWithUsage = new Set<string>();
  const learnedModels = new Map<number, string | null>();
  for (const root of roots) {
    const channel = root.endsWith('antigravity-cli') || root.endsWith('antigravity-acp') ? 'cli' : 'ide';
    const dates = new Map<string, Date>();
    await collectBrainSessionDates(join(root, 'brain'), dates);
    await collectBrowserSessionDates(join(root, 'browser_recordings'), dates);
    for (const [sessionId, timestamp] of dates) {
      const previous = legacy.get(sessionId);
      if (!previous || timestamp < previous.timestamp) legacy.set(sessionId, { timestamp, channel });
    }
    const files = (await entries(join(root, 'conversations'))).filter(entry => entry.isFile()).sort((a, b) => a.name.localeCompare(b.name));
    const dbNames = new Set(files.filter(entry => entry.name.endsWith('.db')).map(entry => entry.name.slice(0, -3)));
    const opaqueCount = files.filter(entry => entry.name.endsWith('.pb') && !dbNames.has(entry.name.slice(0, -3))).length;
    if (opaqueCount) console.warn(`Antigravity: ${opaqueCount} legacy opaque conversation(s) expose no supported offline Token data; activity metadata is retained.`);
    for (const file of files.filter(entry => entry.name.endsWith('.db'))) {
      let conversation;
      try {
        conversation = await readAntigravityConversation(join(root, 'conversations', file.name));
      } catch (error) {
        throw new Error('Antigravity conversation database could not be decoded; sync was stopped to preserve previous uploads', { cause: error });
      }
      if (conversation.learnedModels) {
        for (const [id, model] of conversation.learnedModels) {
          rememberAntigravityModel(learnedModels, id, model);
        }
      }
      if (conversation.records.length) sessionsWithUsage.add(conversation.sessionId);
      for (const record of conversation.records) {
        const fallbackId = `${root}:${record.fallbackId}`;
        contexts.set(fallbackId, { project: conversation.project, sessionId: conversation.sessionId, channel });
        records.push({ ...record, fallbackId });
      }
    }
  }
  // Resolve numeric-only model IDs across all scanned databases (learned names beat static fallback).
  const resolvedRecords = records.map((record) => {
    if (isConcreteAntigravityModel(record.model) || !record.modelId) return record;
    const learned = learnedModels.get(record.modelId);
    const resolved = learned || (learned === null ? undefined : ANTIGRAVITY_MODEL_IDS[record.modelId]);
    return resolved ? { ...record, model: resolved } : record;
  });
  const replacedLegacy = [...sessionsWithUsage].flatMap(session => {
    const previous = legacy.get(session);
    legacy.delete(session);
    return previous ? [previous] : [];
  });
  return { records: deduplicateAntigravityUsage(resolvedRecords), contexts, legacy, replacedLegacy };
}

export async function scanAntigravityDates(
  targetDates: string[],
  baseDir?: string,
  projectAliases?: Record<string, string>,
): Promise<Map<string, IngestBreakdown[]>> {
  const dates = new Set(targetDates);
  const grouped = initDateMap(dates);
  if (!dates.size) return finalize(grouped);
  const data = await readAntigravityData(baseDir);
  const sessions = new Map<string, Set<string>>();
  for (const record of data.records) {
    const day = dateKey(record.timestamp!);
    const map = grouped.get(day);
    if (!map) continue;
    const context = data.contexts.get(record.fallbackId)!;
    const provider = inferProviderFromModel(record.model, 'google');
    const projectFields = resolveProjectFields(context.project, projectAliases);
    const key = `${provider}|${context.channel}|${record.model}|${context.project}`;
    accumulate(map, key, {
      provider, product: 'antigravity', channel: context.channel, model: record.model,
      ...projectFields, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
      reasoningOutputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
    }, record);
    const result = map.get(key)!;
    result.cacheWrite5mTokens = (result.cacheWrite5mTokens ?? 0) + record.cacheWrite;
    const sessionKey = `${day}|${key}`;
    const sessionIds = sessions.get(sessionKey) ?? new Set();
    sessionIds.add(context.sessionId);
    sessions.set(sessionKey, sessionIds);
    result.sessionCount = sessionIds.size;
  }
  for (const { timestamp, channel } of data.legacy.values()) {
    const map = grouped.get(dateKey(timestamp));
    if (!map) continue;
    accumulate(map, `unknown|${channel}`, {
      provider: 'google', product: 'antigravity', channel, model: 'unknown', project: 'unknown',
      inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
    }, { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  }
  // Only clear an old aggregate when its replaced session is still locally
  // provable. A remaining event in the same bucket takes precedence.
  for (const { timestamp, channel } of data.replacedLegacy) {
    const map = grouped.get(dateKey(timestamp));
    const key = `unknown|${channel}`;
    if (map && !map.has(key)) map.set(key, {
      provider: 'google', product: 'antigravity', channel, model: 'unknown', project: 'unknown',
      eventCount: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
      outputTokens: 0, reasoningOutputTokens: 0,
    });
  }
  return finalize(grouped);
}

export async function discoverAntigravityUsageDates(baseDir?: string): Promise<string[]> {
  const data = await readAntigravityData(baseDir);
  return [...new Set([
    ...data.records.map(record => dateKey(record.timestamp!)),
    ...[...data.legacy.values()].map(record => dateKey(record.timestamp)),
    ...data.replacedLegacy.map(record => dateKey(record.timestamp)),
  ])].sort();
}

export async function discoverAntigravityProjects(baseDir?: string): Promise<string[]> {
  const data = await readAntigravityData(baseDir);
  return [...new Set(data.records.map(record => data.contexts.get(record.fallbackId)!.project))]
    .filter(project => project !== 'unknown').sort();
}

async function collectBrainSessionDates(dir: string, sessionDates: Map<string, Date>): Promise<void> {
  for (const entry of await entries(dir)) {
    if (!entry.isDirectory()) continue;
    const metadata = await readJson<AntigravityArtifactMetadata>(join(dir, entry.name, 'task.md.metadata.json'));
    const timestamp = parseTs(metadata?.updatedAt);
    if (timestamp) upsertSessionDate(sessionDates, entry.name, timestamp);
  }
}
async function collectBrowserSessionDates(dir: string, sessionDates: Map<string, Date>): Promise<void> {
  for (const entry of await entries(dir)) {
    if (!entry.isDirectory()) continue;
    const metadata = await readJson<AntigravityBrowserMetadata>(join(dir, entry.name, 'metadata.json'));
    const timestamp = parseTs(metadata?.highlights?.[0]?.start_time ?? metadata?.highlights?.[0]?.end_time);
    if (timestamp) upsertSessionDate(sessionDates, entry.name, timestamp);
  }
}
async function readJson<T>(filePath: string): Promise<T | null> {
  try { return JSON.parse(await readFile(filePath, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Antigravity activity metadata could not be read; sync was stopped to preserve previous uploads', { cause: error });
  }
}
function upsertSessionDate(dates: Map<string, Date>, sessionId: string, timestamp: Date): void {
  const previous = dates.get(sessionId);
  if (!previous || timestamp < previous) dates.set(sessionId, timestamp);
}
