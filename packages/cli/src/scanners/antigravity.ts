import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { IngestBreakdown } from '@aiusage/shared';
import {
  parseTs,
  dateKey,
  initDateMap,
  accumulate,
  finalize,
  emptyResult,
} from './utils.js';

interface AntigravityBrowserMetadata {
  highlights?: Array<{
    start_time?: string;
    end_time?: string;
  }>;
}

interface AntigravityArtifactMetadata {
  updatedAt?: string;
}

interface AntigravityTranscriptRecord {
  type?: string;
  status?: string;
  created_at?: string | number;
}

export async function scanAntigravityDates(
  targetDates: string[],
  baseDir?: string,
): Promise<Map<string, IngestBreakdown[]>> {
  const dates = new Set(targetDates);
  const dir = baseDir ?? join(homedir(), '.gemini', 'antigravity');
  const grouped = initDateMap(dates);
  const sessionDates = new Map<string, Date>();

  const transcriptEvents = await collectTranscriptEvents(join(dir, 'brain'));

  await collectBrainSessionDates(join(dir, 'brain'), sessionDates);
  await collectBrowserSessionDates(join(dir, 'browser_recordings'), sessionDates);

  if (sessionDates.size === 0 && transcriptEvents.size === 0) return emptyResult(dates);

  for (const [sessionId, timestamps] of transcriptEvents) {
    for (const timestamp of timestamps) {
      const dayMap = grouped.get(dateKey(timestamp));
      if (!dayMap) continue;
      accumulateAntigravityEvent(dayMap);
    }

    // A transcript provides finer-grained events for this session, so do not
    // also count its artifact/browser metadata fallback.
    sessionDates.delete(sessionId);
  }

  for (const timestamp of sessionDates.values()) {
    const dayMap = grouped.get(dateKey(timestamp));
    if (!dayMap) continue;
    accumulateAntigravityEvent(dayMap);
  }

  return finalize(grouped);
}

async function collectTranscriptEvents(dir: string): Promise<Map<string, Date[]>> {
  const result = new Map<string, Date[]>();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = join(dir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const timestamps: Date[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record: AntigravityTranscriptRecord;
      try {
        record = JSON.parse(line) as AntigravityTranscriptRecord;
      } catch {
        continue;
      }
      if (record.type !== 'USER_INPUT' || record.status === 'ERROR') continue;
      const timestamp = parseTs(record.created_at);
      if (timestamp) timestamps.push(timestamp);
    }
    if (timestamps.length > 0) result.set(entry.name, timestamps);
  }

  return result;
}

function accumulateAntigravityEvent(dayMap: Map<string, IngestBreakdown>): void {
  accumulate(
    dayMap,
    'unknown|unknown',
    {
      provider: 'google',
      product: 'antigravity',
      channel: 'ide',
      model: 'unknown',
      project: 'unknown',
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
  );
}

async function collectBrainSessionDates(dir: string, sessionDates: Map<string, Date>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const taskMetadata = await readJson<AntigravityArtifactMetadata>(join(dir, entry.name, 'task.md.metadata.json'));
    const timestamp = parseTs(taskMetadata?.updatedAt);
    if (!timestamp) continue;

    upsertSessionDate(sessionDates, entry.name, timestamp);
  }
}

async function collectBrowserSessionDates(dir: string, sessionDates: Map<string, Date>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const metadata = await readJson<AntigravityBrowserMetadata>(join(dir, entry.name, 'metadata.json'));
    const timestamp = parseTs(metadata?.highlights?.[0]?.start_time ?? metadata?.highlights?.[0]?.end_time);
    if (!timestamp) continue;

    upsertSessionDate(sessionDates, entry.name, timestamp);
  }
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function upsertSessionDate(sessionDates: Map<string, Date>, sessionId: string, timestamp: Date): void {
  const existing = sessionDates.get(sessionId);
  if (!existing || timestamp < existing) {
    sessionDates.set(sessionId, timestamp);
  }
}
