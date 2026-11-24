import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { IngestBreakdown } from '@aiusage/shared';
import {
  dateKey,
  emptyResult,
  finalize,
  inferProviderFromModel,
  initDateMap,
  keepFilesModifiedSince,
  parseTs,
  resolveProjectFields,
  runWithConcurrency,
  type ProjectFields,
} from './utils.js';

const FILE_CONCURRENCY = 16;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
export const GROK_COST_USD_TICKS_PER_DOLLAR = 10_000_000_000;

interface GrokUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsdTicks: number | null;
}

interface GrokEvent {
  usageDate: string;
  sessionId: string;
  provider: string;
  model: string;
  projectFields: ProjectFields;
  dedupeKey: string | null;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd: number | null;
}

export function resolveGrokSessionsDir(home = homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GROK_HOME?.trim();
  const root = configured ? expandTilde(configured, home) : join(home, '.grok');
  return join(root, 'sessions');
}

function expandTilde(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2));
  return value;
}

export async function scanGrokDates(
  targetDates: string[],
  sessionsDir?: string,
  projectAliases?: Record<string, string>,
): Promise<Map<string, IngestBreakdown[]>> {
  const dates = new Set(targetDates);
  if (dates.size === 0) return emptyResult(dates);

  const root = sessionsDir ?? resolveGrokSessionsDir();
  const updateFiles = await keepFilesModifiedSince(
    await collectUpdatesFiles(root),
    dates,
    path => path,
  );
  if (updateFiles.length === 0) return emptyResult(dates);

  const eventsByFile: GrokEvent[][] = Array.from({ length: updateFiles.length }, () => []);
  await runWithConcurrency(updateFiles, FILE_CONCURRENCY, async (filePath, index) => {
    const projectFields = resolveProjectFromSessionPath(root, filePath, projectAliases);
    eventsByFile[index] = await parseGrokUpdatesFile(filePath, projectFields);
  });

  // Deduplicate across files by sessionId:promptId:timestampMs:model, keeping the smallest copy
  // when duplicates exist (matches T3 Code's Grok reader semantics).
  const kept: GrokEvent[] = [];
  const seenByKey = new Map<string, number>();
  for (const events of eventsByFile) {
    for (const event of events) {
      if (event.dedupeKey !== null) {
        const existingIndex = seenByKey.get(event.dedupeKey);
        if (existingIndex !== undefined) {
          kept[existingIndex] = smallestGrokEvent(kept[existingIndex]!, event);
          continue;
        }
        seenByKey.set(event.dedupeKey, kept.length);
      }
      kept.push(event);
    }
  }

  const grouped = initDateMap(dates);
  const sessionsByBucket = new Map<string, Set<string>>();

  for (const event of kept) {
    const dayMap = grouped.get(event.usageDate);
    if (!dayMap) continue;

    const key = `${event.provider}|${event.model}|${event.projectFields.project}`;
    const existing = dayMap.get(key);
    if (existing) {
      existing.eventCount += 1;
      existing.inputTokens += event.input;
      existing.cachedInputTokens += event.cached;
      existing.cacheWriteTokens += event.cacheWrite;
      existing.outputTokens += event.output;
      existing.reasoningOutputTokens += event.reasoning;
      if (event.costUsd !== null) {
        existing.costUSD = (existing.costUSD ?? 0) + event.costUsd;
        existing.pricingVersion = 'grok-provider';
      }
    } else {
      const breakdown: IngestBreakdown = {
        provider: event.provider,
        product: 'grok-cli',
        channel: 'cli',
        model: event.model,
        project: event.projectFields.project,
        projectDisplay: event.projectFields.projectDisplay,
        projectAlias: event.projectFields.projectAlias,
        eventCount: 1,
        inputTokens: event.input,
        cachedInputTokens: event.cached,
        cacheWriteTokens: event.cacheWrite,
        outputTokens: event.output,
        reasoningOutputTokens: event.reasoning,
      };
      if (event.costUsd !== null) {
        breakdown.costUSD = event.costUsd;
        breakdown.pricingVersion = 'grok-provider';
      }
      dayMap.set(key, breakdown);
    }

    if (event.sessionId) {
      const sk = `${event.usageDate}|${key}`;
      const set = sessionsByBucket.get(sk) ?? new Set<string>();
      set.add(event.sessionId);
      sessionsByBucket.set(sk, set);
      dayMap.get(key)!.sessionCount = set.size;
    }
  }

  return finalize(grouped);
}

export async function discoverGrokProjects(sessionsDir?: string): Promise<string[]> {
  const root = sessionsDir ?? resolveGrokSessionsDir();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const decoded = decodeProjectSegment(entry.name);
    const fields = resolveProjectFields(decoded);
    if (fields.projectDisplay && fields.projectDisplay !== 'unknown') {
      projects.add(fields.projectDisplay);
    }
  }
  return [...projects];
}

export async function discoverGrokUsageDates(sessionsDir?: string): Promise<string[]> {
  const root = sessionsDir ?? resolveGrokSessionsDir();
  const files = await collectUpdatesFiles(root);
  const dates = new Set<string>();
  await runWithConcurrency(files, FILE_CONCURRENCY, async (filePath) => {
    const events = await parseGrokUpdatesFile(filePath, { project: 'unknown', projectDisplay: 'unknown' });
    for (const event of events) dates.add(event.usageDate);
  });
  return [...dates].sort();
}

async function collectUpdatesFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name === 'updates.jsonl') {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

function decodeProjectSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function resolveProjectFromSessionPath(
  sessionsRoot: string,
  filePath: string,
  projectAliases?: Record<string, string>,
): ProjectFields {
  const rel = relative(sessionsRoot, filePath);
  const firstSegment = rel.split(sep).filter(Boolean)[0];
  if (!firstSegment || firstSegment === 'updates.jsonl') {
    return { project: 'unknown', projectDisplay: 'unknown' };
  }
  const decoded = decodeProjectSegment(firstSegment);
  return resolveProjectFields(decoded, projectAliases);
}

async function parseGrokUpdatesFile(
  filePath: string,
  projectFields: ProjectFields,
): Promise<GrokEvent[]> {
  const events: GrokEvent[] = [];
  const input = createReadStream(filePath, { encoding: 'utf-8' });
  try {
    const rl = createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line || !line.includes('"turn_completed"')) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      for (const event of parseGrokRecord(parsed, projectFields)) {
        events.push(event);
      }
    }
  } catch {
    // Skip transient/deleted files cleanly.
  } finally {
    input.destroy();
  }
  return events;
}

export function parseGrokRecord(parsed: unknown, projectFields: ProjectFields): GrokEvent[] {
  if (!isObject(parsed)) return [];
  const params = isObject(parsed.params) ? parsed.params : null;
  if (!params) return [];
  const update = isObject(params.update) ? params.update : null;
  if (!update || update.sessionUpdate !== 'turn_completed') return [];
  const usage = isObject(update.usage) ? update.usage : null;
  if (!usage) return [];

  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  const promptId = typeof update.prompt_id === 'string' ? update.prompt_id : null;

  const meta = isObject(params._meta) ? params._meta : null;
  const rawTs = (typeof meta?.agentTimestampMs === 'number' && Number.isFinite(meta.agentTimestampMs))
    ? meta.agentTimestampMs
    : (typeof parsed.timestamp === 'number' && Number.isFinite(parsed.timestamp))
      ? parsed.timestamp
      : undefined;
  const ts = parseTs(rawTs);
  if (!ts) return [];
  const usageDate = dateKey(ts);
  const timestampMs = ts.getTime();

  const topLevel = readTotals(usage);
  if (!topLevel) return [];

  const modelUsage = isObject(usage.modelUsage) ? usage.modelUsage : null;
  const entries: Array<{ model: string; totals: GrokUsageTotals }> = [];
  if (modelUsage) {
    for (const [model, raw] of Object.entries(modelUsage)) {
      if (!model) continue;
      const totals = readTotals(raw);
      if (totals) entries.push({ model, totals });
    }
  }

  if (entries.length === 0) {
    const split = splitTokens(topLevel);
    if (split.total === 0) return [];
    return [{
      usageDate,
      sessionId,
      provider: 'xai',
      model: 'grok',
      projectFields,
      dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:${timestampMs}:grok`,
      input: split.input,
      cached: split.cached,
      cacheWrite: split.cacheWrite,
      output: split.output,
      reasoning: split.reasoning,
      costUsd: ticksToUsd(topLevel.costUsdTicks),
    }];
  }

  const topCostUsd = ticksToUsd(topLevel.costUsdTicks);
  let usedTickedUsd = 0;
  let untickedTokens = 0;
  for (const entry of entries) {
    const split = splitTokens(entry.totals);
    if (split.total === 0) continue;
    if (entry.totals.costUsdTicks !== null) {
      usedTickedUsd += ticksToUsd(entry.totals.costUsdTicks) ?? 0;
    } else {
      untickedTokens += split.total;
    }
  }
  const remainingCostUsd = topCostUsd === null ? null : Math.max(0, topCostUsd - usedTickedUsd);

  const results: GrokEvent[] = [];
  for (const entry of entries) {
    const split = splitTokens(entry.totals);
    if (split.total === 0) continue;

    let costUsd = ticksToUsd(entry.totals.costUsdTicks);
    if (costUsd === null && remainingCostUsd !== null && untickedTokens > 0) {
      costUsd = remainingCostUsd * (split.total / untickedTokens);
    }

    results.push({
      usageDate,
      sessionId,
      provider: inferProviderFromModel(entry.model, 'xai'),
      model: entry.model,
      projectFields,
      dedupeKey: promptId === null ? null : `${sessionId}:${promptId}:${timestampMs}:${entry.model}`,
      input: split.input,
      cached: split.cached,
      cacheWrite: split.cacheWrite,
      output: split.output,
      reasoning: split.reasoning,
      costUsd,
    });
  }
  return results;
}

function smallestGrokEvent(a: GrokEvent, b: GrokEvent): GrokEvent {
  return {
    ...a,
    input: Math.min(a.input, b.input),
    cached: Math.min(a.cached, b.cached),
    cacheWrite: Math.min(a.cacheWrite, b.cacheWrite),
    output: Math.min(a.output, b.output),
    reasoning: Math.min(a.reasoning, b.reasoning),
    costUsd: a.costUsd === null || b.costUsd === null
      ? (a.costUsd ?? b.costUsd)
      : Math.min(a.costUsd, b.costUsd),
  };
}

function readTotals(value: unknown): GrokUsageTotals | null {
  if (!isObject(value)) return null;
  return {
    inputTokens: clamp(value.inputTokens),
    outputTokens: clamp(value.outputTokens),
    cachedReadTokens: clamp(value.cachedReadTokens),
    cacheCreationTokens: clamp(value.cacheCreationTokens),
    reasoningTokens: clamp(value.reasoningTokens),
    costUsdTicks: typeof value.costUsdTicks === 'number' && Number.isFinite(value.costUsdTicks) && value.costUsdTicks >= 0
      ? value.costUsdTicks
      : null,
  };
}

function splitTokens(totals: GrokUsageTotals) {
  const cached = Math.min(totals.cachedReadTokens, totals.inputTokens);
  const cacheWrite = Math.min(totals.cacheCreationTokens, Math.max(totals.inputTokens - cached, 0));
  const input = Math.max(0, totals.inputTokens - cached - cacheWrite);
  const reasoning = Math.min(totals.reasoningTokens, totals.outputTokens);
  const output = Math.max(0, totals.outputTokens - reasoning);
  const total = input + cached + cacheWrite + output + reasoning;
  return { input, cached, cacheWrite, output, reasoning, total };
}

function ticksToUsd(ticks: number | null): number | null {
  if (ticks === null || !Number.isFinite(ticks) || ticks < 0) return null;
  return ticks / GROK_COST_USD_TICKS_PER_DOLLAR;
}

function clamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
