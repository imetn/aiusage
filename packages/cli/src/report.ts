import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { IngestBreakdown } from '@aiusage/shared';
import { calculateCost, PRICING_VERSION, type PricingCatalog } from '@aiusage/shared';
import { scanDates } from './scan.js';
import { parseTs, dateKey, fileModifiedTs } from './scanners/utils.js';
import { resolveKimiCodeHome } from './scanners/kimi.js';
import {
  resolveTokscaleTraeCacheDir,
  resolveTraeIntlCacheDir,
  resolveTraeNativeCacheDir,
} from './scanners/trae.js';
import { discoverOpenCodeUsageDates } from './scanners/opencode.js';
import type { PricingInfo } from './pricing.js';

export type ReportRange = '7d' | '1m' | '3m' | '6m' | 'all' | 'today';

interface Totals {
  eventCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

interface DailySummary extends Totals {
  usageDate: string;
}

interface SourceSummary extends Totals {
  source: string;
}

interface ModelSummary extends Totals {
  source: string;
  model: string;
}

export interface LocalReport {
  range: ReportRange;
  rangeLabel: string;
  startDate?: string;
  endDate?: string;
  requestedDays: number;
  daysWithData: number;
  totals: Totals;
  daily: DailySummary[];
  bySource: SourceSummary[];
  byModel: ModelSummary[];
  pricing: PricingInfo;
  pricingWarnings: string[];
  tools?: string[];
}

interface BuildReportOptions {
  projectAliases?: Record<string, string>;
  opencodeDbPaths?: readonly string[];
  /** 直接传入日期列表时忽略 range 参数 */
  dates?: string[];
  tools?: readonly string[];
  pricingCatalog?: PricingCatalog;
  pricingInfo?: PricingInfo;
}

export async function buildLocalReport(
  range: ReportRange,
  options: BuildReportOptions = {},
): Promise<LocalReport> {
  const requestedDates = options.dates
    ? options.dates
    : range === 'all'
    ? await discoverAllDates(options.tools, options.opencodeDbPaths)
    : range === 'today'
    ? [dateKey(getTodayLocalDate())]
    : buildPresetDates(range);

  const daily: DailySummary[] = [];
  const totals = createEmptyTotals();
  const bySource = new Map<string, Totals>();
  const byModel = new Map<string, Totals>();
  const pricingWarnings = new Set<string>();
  let daysWithData = 0;

  const results = await scanDates(requestedDates, {
    projectAliases: options.projectAliases,
    opencodeDbPaths: options.opencodeDbPaths,
    tools: options.tools,
  });

  for (const result of results) {
    const usageDate = result.usageDate;
    const dayTotals = withTotalTokens(result.totals);
    const hasData = result.breakdowns.length > 0 || dayTotals.eventCount > 0 || dayTotals.totalTokens > 0;

    if (hasData) {
      daysWithData += 1;

      for (const breakdown of result.breakdowns) {
        const breakdownTotals = toBreakdownTotals(breakdown, pricingWarnings, options.pricingCatalog);
        dayTotals.estimatedCostUsd += breakdownTotals.estimatedCostUsd;
        mergeTotals(totals, breakdownTotals);
        mergeTotals(getOrCreate(bySource, `${breakdown.provider}/${breakdown.product}`), breakdownTotals);
        mergeTotals(
          getOrCreate(byModel, `${breakdown.provider}/${breakdown.product}|${breakdown.model}`),
          breakdownTotals,
        );
      }
    }

    if (range !== 'all' || hasData) {
      daily.push({ usageDate, ...dayTotals });
    }
  }

  const sortedDates = requestedDates.slice().sort();
  return {
    range,
    rangeLabel: getRangeLabel(range),
    startDate: sortedDates[0],
    endDate: sortedDates[sortedDates.length - 1],
    requestedDays: requestedDates.length,
    daysWithData,
    totals,
    daily,
    bySource: [...bySource.entries()]
      .map(([source, summary]) => ({ source, ...summary }))
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.totalTokens - a.totalTokens),
    byModel: [...byModel.entries()]
      .map(([key, summary]) => {
        const [source, model] = key.split('|');
        return { source, model, ...summary };
      })
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.totalTokens - a.totalTokens),
    pricing: options.pricingInfo ?? {
      source: 'bundled',
      version: options.pricingCatalog?.version ?? 'bundled',
    },
    pricingWarnings: [...pricingWarnings].sort(),
    ...(options.tools ? { tools: [...options.tools] } : {}),
  };
}

export function parseReportRange(value: string | boolean | undefined, today?: boolean): ReportRange {
  if (today) return 'today';
  if (value === undefined || value === true) return '7d';
  if (value === '7d' || value === '1m' || value === '3m' || value === '6m' || value === 'all' || value === 'today') return value;
  throw new Error('--range 仅支持 7d、1m、3m、6m、all、today');
}

function getRangeLabel(range: ReportRange): string {
  switch (range) {
    case '7d':
      return '最近 7 天';
    case '1m':
      return '最近 30 天';
    case '3m':
      return '最近 90 天';
    case '6m':
      return '最近 180 天';
    case 'all':
      return '全部历史';
    case 'today':
      return '今天';
  }
}

function buildPresetDates(range: Exclude<ReportRange, 'all' | 'today'>): string[] {
  const days = range === '7d' ? 7 : range === '1m' ? 30 : range === '3m' ? 90 : 180;
  const today = getTodayLocalDate();
  const result: string[] = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(today);
    day.setDate(today.getDate() - offset);
    result.push(dateKey(day));
  }

  return result;
}

async function discoverAllDates(
  tools?: readonly string[],
  opencodeDbPaths?: readonly string[],
): Promise<string[]> {
  const dates = new Set<string>();
  const home = homedir();
  const selected = tools ? new Set(tools) : null;
  const includes = (...products: string[]) => !selected || products.some(product => selected.has(product));
  const discoveries: Array<Promise<void>> = [];

  if (includes('claude-code')) discoveries.push(discoverClaudeDates(dates));
  if (includes('codex')) discoveries.push(discoverCodexDates(dates));
  if (includes('gemini-cli')) discoveries.push(discoverGeminiDates(dates));
  if (includes('copilot-vscode')) discoveries.push(discoverCopilotVscodeDates(dates));
  if (includes('antigravity')) discoveries.push(discoverAntigravityDates(dates));
  if (includes('copilot-cli')) {
    discoveries.push(discoverGenericJsonlDates(join(home, '.copilot', 'session-state'), dates));
    discoveries.push(discoverGenericJsonlDates(join(home, '.copilot', 'otel'), dates));
  }
  if (includes('qwen-code')) {
    discoveries.push(discoverGenericJsonlDates(join(home, '.qwen', 'tmp'), dates));
    discoveries.push(discoverGenericJsonlDates(join(home, '.qwen', 'projects'), dates));
  }
  if (includes('kimi-code')) {
    discoveries.push(discoverGenericJsonlDates(join(home, '.kimi', 'sessions'), dates));
    discoveries.push(discoverGenericJsonlDates(join(resolveKimiCodeHome(home), 'sessions'), dates));
  }
  if (includes('amp')) discoveries.push(discoverGenericJsonDates(join(home, '.local', 'share', 'amp', 'threads'), dates));
  if (includes('droid')) discoveries.push(discoverGenericJsonDates(join(home, '.factory', 'sessions'), dates));
  if (includes('opencode')) discoveries.push(discoverOpenCodeUsageDates({ dbPaths: opencodeDbPaths }).then(found => { found.forEach(date => dates.add(date)); }));
  if (includes('pi')) {
    discoveries.push(discoverGenericJsonlDates(join(home, '.pi', 'agent', 'sessions'), dates));
    discoveries.push(discoverGenericJsonlDates(join(home, '.omp', 'agent', 'sessions'), dates));
  }
  if (includes('trae-cn', 'trae')) discoveries.push(discoverGenericJsonDates(resolveTraeNativeCacheDir(home), dates));
  if (includes('trae-intl', 'trae')) {
    discoveries.push(discoverGenericJsonDates(resolveTraeIntlCacheDir(home), dates));
    discoveries.push(discoverGenericJsonDates(resolveTokscaleTraeCacheDir(home), dates));
  }

  await Promise.all(discoveries);
  const explicitCopilotOtel = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH?.trim();
  if (explicitCopilotOtel && includes('copilot-cli')) await discoverJsonlFileDates(explicitCopilotOtel, dates);
  return [...dates].sort();
}

/** 通用：递归扫描 .jsonl 文件，逐行提取 timestamp */
async function discoverGenericJsonlDates(baseDir: string, dates: Set<string>): Promise<void> {
  const files: string[] = [];
  await walkForFiles(baseDir, '.jsonl', files);
  for (const filePath of files) {
    const content = await safeReadUtf8(filePath);
    if (!content) continue;
    let foundDate = false;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let record: Record<string, any>;
      try { record = JSON.parse(line); } catch { continue; }
      foundDate = collectRecordDates(record, dates) || foundDate;
    }
    if (!foundDate) await addFileModifiedDate(filePath, dates);
  }
}

async function discoverJsonlFileDates(filePath: string, dates: Set<string>): Promise<void> {
  const content = await safeReadUtf8(filePath);
  if (!content) return;
  let foundDate = false;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      foundDate = collectRecordDates(JSON.parse(line) as Record<string, any>, dates) || foundDate;
    } catch { /* skip */ }
  }
  if (!foundDate) await addFileModifiedDate(filePath, dates);
}

/** 通用：递归扫描 .json 文件，从顶层或 messages 提取 timestamp */
async function discoverGenericJsonDates(baseDir: string, dates: Set<string>): Promise<void> {
  const files: string[] = [];
  await walkForFiles(baseDir, '.json', files);
  for (const filePath of files) {
    const content = await safeReadUtf8(filePath);
    if (!content) continue;
    let data: any;
    try { data = JSON.parse(content); } catch { continue; }
    if (Array.isArray(data) && data.length === 0) continue;
    const foundDate = Array.isArray(data)
      ? data.reduce((found, row) => collectRecordDates(row, dates) || found, false)
      : collectRecordDates(data, dates);
    if (!foundDate) await addFileModifiedDate(filePath, dates);
  }
}

function collectRecordDates(record: Record<string, any> | undefined, dates: Set<string>): boolean {
  if (!record || typeof record !== 'object') return false;
  let found = false;
  const candidates = [
    record.timestamp, record.time, record.created_at, record.createTime, record.startTime,
    record.lastUpdated, record.created, record.providerLockTimestamp, record.endTime,
    record.hrTime, record._hrTime, record.observedTimestamp, record.timeUnixNano,
    record.usage_time,
    record.time?.created,
  ];
  for (const value of candidates) {
    const ts = parseStructuredTs(value);
    if (ts) {
      dates.add(dateKey(ts));
      found = true;
    }
  }
  const nestedRows = [
    ...(Array.isArray(record.messages) ? record.messages : []),
    ...(Array.isArray(record.history) ? record.history : []),
    ...(Array.isArray(record.data?.messages) ? record.data.messages : []),
    ...(Array.isArray(record.data?.history) ? record.data.history : []),
    ...(Array.isArray(record.$set?.messages) ? record.$set.messages : []),
    ...(Array.isArray(record.usageLedger?.events) ? record.usageLedger.events : []),
    ...(Array.isArray(record.events) ? record.events : []),
  ];
  for (const row of nestedRows) found = collectRecordDates(row, dates) || found;
  return found;
}

function parseStructuredTs(value: unknown): Date | null {
  if (Array.isArray(value) && value.length > 0) {
    const seconds = Number(value[0]);
    const nanos = Number(value[1] ?? 0);
    if (Number.isFinite(seconds) && Number.isFinite(nanos)) {
      return parseTs(seconds * 1_000 + nanos / 1_000_000);
    }
  }
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) {
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    const abs = Math.abs(raw);
    const millis = abs >= 1e17 ? raw / 1e6 : abs >= 1e14 ? raw / 1e3 : raw;
    return parseTs(millis);
  }
  return parseTs(value as string | number | undefined);
}

async function addFileModifiedDate(filePath: string, dates: Set<string>): Promise<void> {
  const timestamp = await fileModifiedTs(filePath);
  if (timestamp) dates.add(dateKey(timestamp));
}

async function walkForFiles(dir: string, ext: string, result: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkForFiles(fullPath, ext, result);
    } else if (entry.name.endsWith(ext)) {
      result.push(fullPath);
    }
  }
}

async function discoverGeminiDates(dates: Set<string>): Promise<void> {
  const baseDir = join(homedir(), '.gemini', 'tmp');
  await Promise.all([
    discoverGenericJsonDates(baseDir, dates),
    discoverGenericJsonlDates(baseDir, dates),
  ]);
}

async function discoverCopilotVscodeDates(dates: Set<string>): Promise<void> {
  const home = homedir();
  const logFiles: string[] = [];
  await walkForFiles(join(home, 'Library', 'Application Support', 'Code', 'logs'), '.log', logFiles);
  for (const filePath of logFiles) {
    if (basename(filePath) !== 'GitHub Copilot Chat.log') continue;
    const content = await safeReadUtf8(filePath);
    if (!content) continue;
    for (const line of content.split('\n')) {
      if (!line.includes('ccreq:') || !line.includes('| success |')) continue;
      const ts = parseTs(line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)/)?.[1]?.replace(' ', 'T'));
      if (ts) dates.add(dateKey(ts));
    }
  }

  const sessionFiles: string[] = [];
  await walkForFiles(join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'), '.json', sessionFiles);
  for (const filePath of sessionFiles) {
    if (!isChatSessionFile(filePath)) continue;
    const content = await safeReadUtf8(filePath);
    if (!content) continue;
    let session: { requests?: Array<{ timestamp?: string | number; response?: unknown[]; result?: { errorDetails?: { responseIsIncomplete?: boolean } } }> };
    try {
      session = JSON.parse(content);
    } catch {
      continue;
    }
    for (const request of session.requests ?? []) {
      if ((request.response?.length ?? 0) === 0) continue;
      if (request.result?.errorDetails?.responseIsIncomplete) continue;
      const ts = parseTs(request.timestamp);
      if (ts) dates.add(dateKey(ts));
    }
  }

  const crdtFiles: string[] = [];
  await walkForFiles(
    join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
    '.jsonl',
    crdtFiles,
  );
  for (const filePath of crdtFiles) {
    if (!isChatSessionFile(filePath)) continue;
    const content = await safeReadUtf8(filePath);
    if (!content) continue;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let record: { kind?: number; k?: unknown[]; v?: unknown };
      try {
        record = JSON.parse(line) as { kind?: number; k?: unknown[]; v?: unknown };
      } catch {
        continue;
      }
      const root = record.v && typeof record.v === 'object' && !Array.isArray(record.v)
        ? record.v as { requests?: unknown[] }
        : undefined;
      const requests = record.kind === 0 && Array.isArray(root?.requests)
        ? root.requests
        : record.kind === 2 && record.k?.[0] === 'requests' && Array.isArray(record.v)
          ? record.v
          : [];
      for (const value of requests) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const request = value as {
          timestamp?: string | number;
          modelId?: string;
          promptTokens?: number;
          completionTokens?: number;
          result?: { metadata?: { promptTokens?: number; outputTokens?: number; resolvedModel?: string } };
        };
        const metadata = request.result?.metadata;
        const isCopilot = Boolean(metadata?.resolvedModel) || request.modelId?.startsWith('copilot/');
        const hasTokens = (request.promptTokens ?? metadata?.promptTokens ?? 0) > 0
          || (request.completionTokens ?? metadata?.outputTokens ?? 0) > 0;
        if (!isCopilot || !hasTokens) continue;
        const ts = parseTs(request.timestamp);
        if (ts) dates.add(dateKey(ts));
      }
    }
  }
}

function isChatSessionFile(filePath: string): boolean {
  return basename(dirname(filePath)) === 'chatSessions';
}

async function discoverAntigravityDates(dates: Set<string>): Promise<void> {
  const home = homedir();
  const brainFiles: string[] = [];
  const browserFiles: string[] = [];
  const transcriptFiles: string[] = [];
  await walkForFiles(join(home, '.gemini', 'antigravity', 'brain'), '.json', brainFiles);
  await walkForFiles(join(home, '.gemini', 'antigravity', 'brain'), '.jsonl', transcriptFiles);
  await walkForFiles(join(home, '.gemini', 'antigravity', 'browser_recordings'), '.json', browserFiles);

  for (const filePath of transcriptFiles) {
    if (basename(filePath) !== 'transcript.jsonl') continue;
    const content = await safeReadUtf8(filePath);
    if (!content) continue;
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let data: { type?: string; status?: string; created_at?: string | number };
      try {
        data = JSON.parse(line);
      } catch {
        continue;
      }
      if (data.type !== 'USER_INPUT' || data.status === 'ERROR') continue;
      const ts = parseTs(data.created_at);
      if (ts) dates.add(dateKey(ts));
    }
  }

  for (const filePath of brainFiles) {
    if (basename(filePath) !== 'task.md.metadata.json') continue;
    const content = await safeReadUtf8(filePath);
    if (!content) continue;
    let data: { updatedAt?: string | number };
    try {
      data = JSON.parse(content);
    } catch {
      continue;
    }
    const ts = parseTs(data.updatedAt);
    if (ts) dates.add(dateKey(ts));
  }

  for (const filePath of browserFiles) {
    if (basename(filePath) !== 'metadata.json') continue;
    const content = await safeReadUtf8(filePath);
    if (!content) continue;
    let data: { highlights?: Array<{ start_time?: string | number; end_time?: string | number }> };
    try {
      data = JSON.parse(content);
    } catch {
      continue;
    }
    const ts = parseTs(data.highlights?.[0]?.start_time ?? data.highlights?.[0]?.end_time);
    if (ts) dates.add(dateKey(ts));
  }
}

async function discoverClaudeDates(dates: Set<string>): Promise<void> {
  const home = homedir();
  const baseDirs = [
    join(home, '.config', 'claude', 'projects'),
    join(home, '.claude', 'projects'),
  ];

  for (const baseDir of baseDirs) {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(baseDir);
    } catch {
      continue;
    }

    for (const projectDir of projectDirs) {
      const jsonlFiles: string[] = [];
      try {
        await walkForClaudeJsonl(join(baseDir, projectDir), jsonlFiles);
      } catch {
        continue;
      }

      for (const filePath of jsonlFiles) {
        const content = await safeReadUtf8(filePath);
        if (!content) continue;

        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          let record: { timestamp?: string };
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          const ts = parseTs(record.timestamp);
          if (ts) dates.add(dateKey(ts));
        }
      }
    }
  }
}

async function discoverCodexDates(dates: Set<string>): Promise<void> {
  const baseDir = join(homedir(), '.codex');
  const files = await collectCodexSessionFiles(baseDir);

  for (const filePath of files) {
    const content = await safeReadUtf8(filePath);
    if (!content) continue;

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let record: { type?: string; timestamp?: string; payload?: { type?: string } };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type !== 'event_msg' || record.payload?.type !== 'token_count') continue;
      const ts = parseTs(record.timestamp);
      if (ts) dates.add(dateKey(ts));
    }
  }
}

async function collectCodexSessionFiles(baseDir: string): Promise<string[]> {
  const paths: string[] = [];

  try {
    const archivedFiles = await readdir(join(baseDir, 'archived_sessions'));
    for (const file of archivedFiles) {
      if (file.endsWith('.jsonl')) paths.push(join(baseDir, 'archived_sessions', file));
    }
  } catch {
    // ignore
  }

  await walkForCodexJsonl(join(baseDir, 'sessions'), paths);
  return paths;
}

async function walkForClaudeJsonl(dir: string, result: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkForClaudeJsonl(fullPath, result);
    } else if (entry.name.endsWith('.jsonl')) {
      result.push(fullPath);
    }
  }
}

async function walkForCodexJsonl(dir: string, result: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkForCodexJsonl(fullPath, result);
    } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      result.push(fullPath);
    }
  }
}

async function safeReadUtf8(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function getTodayLocalDate(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function getOrCreate(map: Map<string, Totals>, key: string): Totals {
  const existing = map.get(key);
  if (existing) return existing;
  const next = createEmptyTotals();
  map.set(key, next);
  return next;
}

function withTotalTokens(totals: Omit<Totals, 'totalTokens' | 'estimatedCostUsd'>): Totals {
  return {
    ...totals,
    totalTokens:
      totals.inputTokens +
      totals.cachedInputTokens +
      totals.cacheWriteTokens +
      totals.outputTokens +
      totals.reasoningOutputTokens,
    estimatedCostUsd: 0,
  };
}

function createEmptyTotals(): Totals {
  return {
    eventCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
  };
}

function mergeTotals(target: Totals, source: Totals): Totals {
  target.eventCount += source.eventCount;
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  target.totalTokens += source.totalTokens;
  target.estimatedCostUsd += source.estimatedCostUsd;
  return target;
}

function toBreakdownTotals(
  breakdown: IngestBreakdown,
  warnings: Set<string>,
  pricingCatalog?: PricingCatalog,
): Totals {
  const estimatedCostUsd = calculateBreakdownCost(breakdown, warnings, pricingCatalog);
  return {
    eventCount: breakdown.eventCount,
    inputTokens: breakdown.inputTokens,
    cachedInputTokens: breakdown.cachedInputTokens,
    cacheWriteTokens: breakdown.cacheWriteTokens,
    outputTokens: breakdown.outputTokens,
    reasoningOutputTokens: breakdown.reasoningOutputTokens,
    totalTokens:
      breakdown.inputTokens +
      breakdown.cachedInputTokens +
      breakdown.cacheWriteTokens +
      breakdown.outputTokens +
      breakdown.reasoningOutputTokens,
    estimatedCostUsd,
  };
}

/**
 * 计算单个 breakdown 的成本：
 * 1. Trae 国际版官方 API 与 OpenCode 本地记录的供应商费用始终采用
 * 2. 其他 scanner 的 costUSD 仅在定价版本匹配时采用
 * 3. 否则委托给 @aiusage/shared 的 calculateCost
 *
 * 失败/估算情况注入 warning 给上层报告展示。
 */
export function calculateBreakdownCost(
  breakdown: IngestBreakdown,
  warnings: Set<string>,
  pricingCatalog?: PricingCatalog,
): number {
  const effectivePricingVersion = pricingCatalog?.version ?? PRICING_VERSION;
  const sourceCostMatchesCatalog =
    breakdown.product === 'trae-intl' ||
    breakdown.product === 'opencode' ||
    breakdown.pricingVersion == null ||
    breakdown.pricingVersion === effectivePricingVersion;
  if (breakdown.costUSD != null && breakdown.costUSD > 0 && sourceCostMatchesCatalog) {
    return breakdown.costUSD;
  }

  const result = calculateCost(
    breakdown.provider,
    breakdown.product,
    breakdown.model,
    {
      inputTokens: breakdown.inputTokens,
      cachedInputTokens: breakdown.cachedInputTokens,
      cacheWriteTokens: breakdown.cacheWriteTokens,
      cacheWrite5mTokens: breakdown.cacheWrite5mTokens,
      cacheWrite1hTokens: breakdown.cacheWrite1hTokens,
      outputTokens: breakdown.outputTokens,
    },
    {
      ...(pricingCatalog ? { catalog: pricingCatalog } : {}),
      requestCount: breakdown.eventCount,
    },
  );

  if (result.costStatus === 'unavailable') {
    warnings.add(`${breakdown.provider}/${breakdown.product}/${breakdown.model} 暂无定价配置，已跳过成本估算。`);
  } else if (result.costStatus === 'estimated' && result.resolvedModel && result.resolvedModel !== breakdown.model) {
    warnings.add(`${breakdown.model} 已按 ${result.resolvedModel} 的公开单价估算。`);
  } else if (result.costStatus === 'estimated' && result.matchedTierIndex !== undefined) {
    warnings.add(`${breakdown.model} 的阶梯价格已按每事件平均输入量估算。`);
  }

  return result.estimatedCostUsd;
}
