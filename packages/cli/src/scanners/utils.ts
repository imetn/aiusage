import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { IngestBreakdown } from '@aiusage/shared';

/** 早于此刻视为脏数据下界（2015-01-01），用于过滤被误判单位的时间戳 */
const MIN_VALID_MS = Date.UTC(2015, 0, 1);

export function parseTs(value?: string | number): Date | null {
  if (value == null || value === '') return null;
  // 数值时间戳：区分秒级（10 位）与毫秒级（13 位）。
  // 形如 1775196391.26 的秒级值若按毫秒解析会落到 1970，需先 ×1000。
  let input: string | number = value;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(value)) {
    const num = typeof value === 'number' ? value : Number(value);
    input = num < 1e12 ? num * 1000 : num;
  }
  const d = new Date(input);
  const t = d.getTime();
  if (isNaN(t) || t < MIN_VALID_MS) return null;
  return d;
}

export function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 文件内没有可靠时间戳时，以 mtime 兜底，避免有真实 token 的记录被静默丢弃。 */
export async function fileModifiedTs(filePath: string): Promise<Date | null> {
  try {
    return parseTs((await stat(filePath)).mtimeMs);
  } catch {
    return null;
  }
}

/** 根据模型名推断底层供应商；无法识别时保留调用方指定的产品供应商。 */
export function inferProviderFromModel(model: string, fallback: string): string {
  const value = model.trim().toLowerCase();
  if (/^(claude|opus|sonnet|haiku)(?:[-.]|$)/.test(value)) return 'anthropic';
  if (/^(gpt|chatgpt|codex|o[134])(?:[-.]|$)/.test(value)) return 'openai';
  if (/^gemini(?:[-.]|$)/.test(value)) return 'google';
  if (/^qwen(?:[-.]|$)/.test(value)) return 'alibaba';
  if (/^deepseek(?:[-.]|$)/.test(value)) return 'deepseek';
  if (/^(glm|codegeex)(?:[-.]|$)/.test(value)) return 'zhipu';
  if (/^(kimi|moonshot)(?:[-/.]|$)/.test(value)) return 'moonshot';
  if (/^grok(?:[-.]|$)/.test(value)) return 'xai';
  return fallback;
}

export function projectFromPath(raw: string, aliases?: Record<string, string>): string {
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  const name = parts[parts.length - 1] || 'unknown';
  return aliases?.[raw] ?? aliases?.[name] ?? name;
}

export interface ProjectFields {
  project: string;
  projectDisplay: string;
  projectAlias?: string;
}

export function resolveProjectFields(
  rawPath: string,
  aliases?: Record<string, string>,
): ProjectFields {
  const parts = rawPath.split(/[\\/]+/).filter(Boolean);
  const display = parts[parts.length - 1] || 'unknown';
  const alias = aliases?.[rawPath] ?? aliases?.[display];
  return {
    project: rawPath || 'unknown',
    projectDisplay: display,
    projectAlias: alias,
  };
}

export async function walkFiles(dir: string, ext: string): Promise<string[]> {
  const result: string[] = [];
  await walk(dir, ext, result);
  return result;
}

async function walk(dir: string, ext: string, out: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, ext, out);
    else if (e.name.endsWith(ext)) out.push(full);
  }
}

export type DateGrouped = Map<string, Map<string, IngestBreakdown>>;

export function initDateMap(dates: Set<string>): DateGrouped {
  const m: DateGrouped = new Map();
  for (const d of dates) m.set(d, new Map());
  return m;
}

export function accumulate(
  grouped: Map<string, IngestBreakdown>,
  key: string,
  base: Omit<IngestBreakdown, 'eventCount'>,
  tokens: { input: number; cached: number; cacheWrite: number; output: number; reasoning: number },
): void {
  const existing = grouped.get(key);
  if (existing) {
    existing.eventCount += 1;
    existing.inputTokens += tokens.input;
    existing.cachedInputTokens += tokens.cached;
    existing.cacheWriteTokens += tokens.cacheWrite;
    existing.outputTokens += tokens.output;
    existing.reasoningOutputTokens += tokens.reasoning;
  } else {
    grouped.set(key, {
      ...base,
      eventCount: 1,
      inputTokens: tokens.input,
      cachedInputTokens: tokens.cached,
      cacheWriteTokens: tokens.cacheWrite,
      outputTokens: tokens.output,
      reasoningOutputTokens: tokens.reasoning,
    });
  }
}

export function finalize(groupedByDate: DateGrouped): Map<string, IngestBreakdown[]> {
  return new Map(
    [...groupedByDate.entries()].map(([d, m]) => [d, [...m.values()]]),
  );
}

export function emptyResult(dates: Set<string>): Map<string, IngestBreakdown[]> {
  return new Map([...dates].map(d => [d, []]));
}

// 归一化模型名，去掉日期后缀（如 claude-3-5-sonnet-20241022 → claude-3-5-sonnet）
export function normalizeModelName(name: string): string {
  return name.replace(/-\d{8}$/, '');
}

/**
 * 文件最后写入早于最早目标日期时不可能含目标日记录，跳过以免每次同步读遍全部历史；
 * 留一天余量覆盖时区差。未指定日期时原样返回。
 */
export async function keepFilesModifiedSince<T>(
  items: T[],
  targetDates: Iterable<string> | undefined,
  pathOf: (item: T) => string,
): Promise<T[]> {
  const dates = targetDates ? [...targetDates].sort() : [];
  if (dates.length === 0) return items;
  const cutoff = Date.parse(`${dates[0]}T00:00:00Z`) - 24 * 60 * 60 * 1000;
  const keep = await Promise.all(items.map(async item => {
    try {
      return (await stat(pathOf(item))).mtimeMs >= cutoff;
    } catch {
      return false;
    }
  }));
  return items.filter((_, i) => keep[i]);
}

// Pool-based 并发控制，避免同时打开过多文件句柄
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (;;) {
        const i = nextIndex++;
        if (i >= items.length) return;
        await worker(items[i], i);
      }
    }),
  );
}
