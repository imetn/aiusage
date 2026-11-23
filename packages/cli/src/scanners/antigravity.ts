import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { IngestBreakdown } from '@aiusage/shared';
import {
  parseTs, dateKey, initDateMap, accumulate, finalize, inferProviderFromModel, resolveProjectFields,
} from './utils.js';
import {
  deduplicateAntigravityUsage, readAntigravityConversation,
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

async function readAntigravityData(baseDir?: string): Promise<AntigravityData> {
  const roots = baseDir ? [baseDir] : ['antigravity', 'antigravity-cli', 'antigravity-ide'].map(name => join(homedir(), '.gemini', name));
  const records: AntigravityUsage[] = [];
  const contexts = new Map<string, UsageContext>();
  const legacy = new Map<string, { timestamp: Date; channel: 'cli' | 'ide' }>();
  const sessionsWithUsage = new Set<string>();
  for (const root of roots) {
    const channel = root.endsWith('antigravity-cli') ? 'cli' : 'ide';
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
      if (conversation.records.length) sessionsWithUsage.add(conversation.sessionId);
      for (const record of conversation.records) {
        const fallbackId = `${root}:${record.fallbackId}`;
        contexts.set(fallbackId, { project: conversation.project, sessionId: conversation.sessionId, channel });
        records.push({ ...record, fallbackId });
      }
    }
  }
  const replacedLegacy = [...sessionsWithUsage].flatMap(session => {
    const previous = legacy.get(session);
    legacy.delete(session);
    return previous ? [previous] : [];
  });
  return { records: deduplicateAntigravityUsage(records), contexts, legacy, replacedLegacy };
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
