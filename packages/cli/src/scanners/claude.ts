import { createReadStream } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { IngestBreakdown } from '@aiusage/shared';
import { inferProviderFromModel, keepFilesModifiedSince, normalizeModelName, runWithConcurrency, type ProjectFields } from './utils.js';

const FILE_CONCURRENCY = 16;
const MAX_LINE_BYTES = 64 * 1024 * 1024; // 64 MB
const MAX_COWORK_DISCOVERY_DEPTH = 8;
const COWORK_IGNORED_DIRS = new Set(['rpm', 'skills']);

interface ClaudeRecord {
  timestamp?: string;
  requestId?: string;
  uuid?: string;
  sessionId?: string;
  type?: string;
  cwd?: string;
  costUSD?: number;
  providerId?: string;
  provider_id?: string;
  provider?: string;
  message?: {
    id?: string;
    model?: string;
    providerId?: string;
    provider_id?: string;
    provider?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
      speed?: 'standard' | 'fast';
    };
  };
}

interface ClaudeUsageSnapshot {
  input: number;
  cached: number;
  cacheWrite: number;
  cache5m: number;
  cache1h: number;
  output: number;
  costUSD: number;
}

interface ClaudeSeenUsage {
  breakdown: IngestBreakdown;
  snapshot: ClaudeUsageSnapshot;
}

interface ClaudeDiscoveryOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve every Claude Code-compatible project directory visible locally.
 * Claude Desktop Cowork keeps one private .claude root per local-agent session.
 */
export async function discoverClaudeProjectDirs(
  claudeDir?: string,
  options: ClaudeDiscoveryOptions = {},
): Promise<string[]> {
  if (claudeDir) return [claudeDir];

  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const candidates = [
    join(home, '.config', 'claude', 'projects'),
    join(home, '.claude', 'projects'),
  ];

  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  if (configured) {
    for (const root of configured.split(',').map(p => p.trim()).filter(Boolean)) {
      candidates.push(join(root, 'projects'));
    }
  }

  try {
    const entries = await readdir(home, { withFileTypes: true });
    for (const entry of entries) {
      if (!/^\.claude-.+/.test(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      candidates.push(join(home, entry.name, 'projects'));
    }
  } catch {
    // Default and configured roots remain usable when home discovery fails.
  }

  const desktopDataDir = platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Claude')
    : platform === 'win32'
      ? join(env.APPDATA?.trim() || join(home, 'AppData', 'Roaming'), 'Claude')
      : join(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'Claude');
  await discoverCoworkProjectDirs(
    join(desktopDataDir, 'local-agent-mode-sessions'),
    0,
    candidates,
  );

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of candidates) {
    let canonical = candidate;
    try {
      canonical = await realpath(candidate);
    } catch {
      // Missing roots are harmless; the scanner skips them below.
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    unique.push(candidate);
  }
  return unique;
}

export async function scanClaude(
  targetDate: string,
  claudeDir?: string,
  projectAliases?: Record<string, string>,
): Promise<IngestBreakdown[]> {
  const groupedByDate = await scanClaudeDates([targetDate], claudeDir, projectAliases);
  return groupedByDate.get(targetDate) ?? [];
}

export async function scanClaudeDates(
  targetDates: string[],
  claudeDir?: string,
  projectAliases?: Record<string, string>,
): Promise<Map<string, IngestBreakdown[]>> {
  const targetDateSet = new Set(targetDates);
  const groupedByDate = new Map<string, Map<string, IngestBreakdown>>();
  for (const targetDate of targetDateSet) groupedByDate.set(targetDate, new Map());

  const baseDirs = await discoverClaudeProjectDirs(claudeDir);

  // Claude Code 某些代理/兼容模型没有 requestId，但仍会把同一 messageId
  // 复制到父会话和 sidechain 文件；此时退化为 message.id 去重。
  const processedHashes = new Map<string, ClaudeSeenUsage>();

  // Track distinct sessions per "date|model|project" group
  const sessionSets = new Map<string, Set<string>>();

  // 收集所有 { filePath, projectFields } 对
  const fileJobs: { filePath: string; projectFields: ProjectFields }[] = [];

  for (const baseDir of baseDirs) {
    let projectDirs: string[];
    try {
      projectDirs = await readdir(baseDir);
    } catch {
      continue;
    }

    for (const projDir of projectDirs) {
      const projectPath = join(baseDir, projDir);
      const fields = resolveProject(projectPath, projectAliases);

      const jsonlFiles: string[] = [];
      try {
        await walkForJsonl(projectPath, jsonlFiles);
      } catch {
        continue;
      }

      for (const filePath of jsonlFiles) {
        fileJobs.push({ filePath, projectFields: fields });
      }
    }
  }
  fileJobs.sort((a, b) => a.filePath.localeCompare(b.filePath));
  const recentJobs = await keepFilesModifiedSince(fileJobs, targetDateSet, job => job.filePath);

  // 并发流式处理文件，直接聚合到 groupedByDate
  await runWithConcurrency(recentJobs, FILE_CONCURRENCY, async (job) => {
    await processJsonlFile(job.filePath, job.projectFields, targetDateSet, projectAliases, groupedByDate, processedHashes, sessionSets);
  });

  // Assign session counts from collected sessionSets
  for (const [usageDate, grouped] of groupedByDate.entries()) {
    for (const [key, breakdown] of grouped.entries()) {
      const sessionSetKey = `${usageDate}|${key}`;
      breakdown.sessionCount = sessionSets.get(sessionSetKey)?.size ?? 0;
    }
  }

  return new Map(
    [...groupedByDate.entries()].map(([usageDate, grouped]) => [usageDate, [...grouped.values()]]),
  );
}

/** 流式逐行读取单个 JSONL 文件，避免全量加载到内存 */
async function processJsonlFile(
  filePath: string,
  fallbackFields: ProjectFields,
  targetDateSet: Set<string>,
  projectAliases: Record<string, string> | undefined,
  groupedByDate: Map<string, Map<string, IngestBreakdown>>,
  processedHashes: Map<string, ClaudeSeenUsage>,
  sessionSets: Map<string, Set<string>>,
): Promise<void> {
  // Derive fallback sessionId from filename (e.g. "abc-123.jsonl" → "abc-123")
  const fallbackSessionId = filePath.replace(/^.*[\\/]/, '').replace(/\.jsonl$/, '');
  const input = createReadStream(filePath, { encoding: 'utf-8' });
  try {
    const rl = createInterface({
      input,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line) continue;

      // 大行保护
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) continue;

      let record: ClaudeRecord;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const ts = parseTimestamp(record.timestamp);
      if (!ts) continue;
      const usageDate = toDateKey(ts);
      if (!targetDateSet.has(usageDate)) continue;

      const message = record.message;
      if (!message?.usage) continue;

      // 过滤合成消息
      const rawModel = message.model ?? 'unknown';
      if (rawModel === '<synthetic>') continue;

      // 标准记录用 messageId:requestId；兼容模型缺 requestId 时用 message.id。
      const messageId = message.id;
      const requestId = record.requestId;
      const hash = messageId
        ? (requestId ? `${messageId}:${requestId}` : `message:${messageId}`)
        : undefined;

      const usage = message.usage;
      let model = normalizeModelName(rawModel);
      if (usage.speed === 'fast') model = `${model}-fast`;
      const provider = resolveClaudeProvider(record, rawModel);
      const recordFields = record.cwd ? resolveProject(record.cwd, projectAliases) : fallbackFields;
      const sessionId = record.sessionId ?? fallbackSessionId;
      const costUSD = record.costUSD ?? 0;

      const cacheCreation = usage.cache_creation;
      let cache5m = cacheCreation?.ephemeral_5m_input_tokens ?? 0;
      const cache1h = cacheCreation?.ephemeral_1h_input_tokens ?? 0;
      // 无明细时退化到总量
      if (cache5m === 0 && cache1h === 0 && (usage.cache_creation_input_tokens ?? 0) > 0) {
        cache5m = usage.cache_creation_input_tokens!;
      }

      const grouped = groupedByDate.get(usageDate);
      if (!grouped) continue;

      const snapshot: ClaudeUsageSnapshot = {
        input: clampToken(usage.input_tokens),
        cached: clampToken(usage.cache_read_input_tokens),
        cacheWrite: clampToken(usage.cache_creation_input_tokens)
          || clampToken(cache5m) + clampToken(cache1h),
        cache5m: clampToken(cache5m),
        cache1h: clampToken(cache1h),
        output: clampToken(usage.output_tokens),
        costUSD: clampToken(costUSD),
      };
      const cacheWriteTokens = snapshot.cacheWrite;
      const seen = hash ? processedHashes.get(hash) : undefined;
      if (seen) {
        mergeClaudeDuplicate(seen, snapshot);
        continue;
      }
      const key = `${provider}|${model}|${recordFields.project}`;

      // Track distinct sessions per group
      const sessionSetKey = `${usageDate}|${key}`;
      if (!sessionSets.has(sessionSetKey)) sessionSets.set(sessionSetKey, new Set());
      sessionSets.get(sessionSetKey)!.add(sessionId);

      const existing = grouped.get(key);
      if (existing) {
        existing.eventCount += 1;
        existing.inputTokens += snapshot.input;
        existing.cachedInputTokens += snapshot.cached;
        existing.cacheWriteTokens += cacheWriteTokens;
        existing.cacheWrite5mTokens = (existing.cacheWrite5mTokens ?? 0) + snapshot.cache5m;
        existing.cacheWrite1hTokens = (existing.cacheWrite1hTokens ?? 0) + snapshot.cache1h;
        existing.outputTokens += snapshot.output;
        existing.costUSD = (existing.costUSD ?? 0) + snapshot.costUSD;
        if (hash) processedHashes.set(hash, { breakdown: existing, snapshot });
      } else {
        const breakdown: IngestBreakdown = {
          provider,
          product: 'claude-code',
          channel: 'cli',
          model,
          project: recordFields.project,
          projectDisplay: recordFields.projectDisplay,
          projectAlias: recordFields.projectAlias,
          eventCount: 1,
          inputTokens: snapshot.input,
          cachedInputTokens: snapshot.cached,
          cacheWriteTokens,
          cacheWrite5mTokens: snapshot.cache5m,
          cacheWrite1hTokens: snapshot.cache1h,
          outputTokens: snapshot.output,
          reasoningOutputTokens: 0,
          costUSD: snapshot.costUSD,
        };
        grouped.set(key, breakdown);
        if (hash) processedHashes.set(hash, { breakdown, snapshot });
      }
    }
  } catch {
    // 文件在扫描期间被移动、归档或损坏时跳过该文件。
  } finally {
    input.destroy();
  }
}

function mergeClaudeDuplicate(seen: ClaudeSeenUsage, incoming: ClaudeUsageSnapshot): void {
  const incomingHasNewerCacheWrite = incoming.cacheWrite > seen.snapshot.cacheWrite;
  const merged: ClaudeUsageSnapshot = {
    input: Math.max(seen.snapshot.input, incoming.input),
    cached: Math.max(seen.snapshot.cached, incoming.cached),
    cacheWrite: Math.max(seen.snapshot.cacheWrite, incoming.cacheWrite),
    cache5m: incomingHasNewerCacheWrite ? incoming.cache5m : seen.snapshot.cache5m,
    cache1h: incomingHasNewerCacheWrite ? incoming.cache1h : seen.snapshot.cache1h,
    output: Math.max(seen.snapshot.output, incoming.output),
    costUSD: Math.max(seen.snapshot.costUSD, incoming.costUSD),
  };
  const breakdown = seen.breakdown;
  breakdown.inputTokens += merged.input - seen.snapshot.input;
  breakdown.cachedInputTokens += merged.cached - seen.snapshot.cached;
  breakdown.cacheWrite5mTokens = (breakdown.cacheWrite5mTokens ?? 0)
    + merged.cache5m - seen.snapshot.cache5m;
  breakdown.cacheWrite1hTokens = (breakdown.cacheWrite1hTokens ?? 0)
    + merged.cache1h - seen.snapshot.cache1h;
  breakdown.cacheWriteTokens += merged.cacheWrite - seen.snapshot.cacheWrite;
  breakdown.outputTokens += merged.output - seen.snapshot.output;
  breakdown.costUSD = (breakdown.costUSD ?? 0) + merged.costUSD - seen.snapshot.costUSD;
  seen.snapshot = merged;
}

function clampToken(value: number | undefined): number {
  return Math.max(Number.isFinite(value) ? value! : 0, 0);
}

function resolveClaudeProvider(record: ClaudeRecord, model: string): string {
  const explicit = (
    record.message?.providerId
    ?? record.message?.provider_id
    ?? record.message?.provider
    ?? record.providerId
    ?? record.provider_id
    ?? record.provider
  )?.trim().toLowerCase();
  const prefix = model.trim().toLowerCase().match(/^([a-z0-9_-]+)\//)?.[1];
  const inferred = prefix ?? inferProviderFromModel(model, 'unknown');
  // 一些兼容层会固定写 anthropic，但模型名已明确指向其他供应商。
  if (explicit && explicit !== 'anthropic') return explicit;
  if (inferred !== 'unknown') return inferred;
  return explicit ?? 'unknown';
}

function parseTimestamp(value?: string): Date | null {
  if (!value) return null;
  try {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function extractProjectFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'unknown';
}

function resolveProject(rawPath: string, aliases?: Record<string, string>): ProjectFields {
  const project = extractProjectFromCwd(rawPath);
  const alias = aliases?.[rawPath] ?? aliases?.[project];
  return { project: rawPath, projectDisplay: project, projectAlias: alias };
}

async function walkForJsonl(dir: string, result: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkForJsonl(fullPath, result);
    } else if (entry.name.endsWith('.jsonl')) {
      result.push(fullPath);
    }
  }
}

async function discoverCoworkProjectDirs(
  dir: string,
  depth: number,
  result: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const claudeRoot = entries.find(entry => entry.name === '.claude' && entry.isDirectory());
  if (claudeRoot) {
    result.push(join(dir, '.claude', 'projects'));
    return;
  }
  if (depth >= MAX_COWORK_DISCOVERY_DEPTH) return;

  for (const entry of entries) {
    if (!entry.isDirectory() || COWORK_IGNORED_DIRS.has(entry.name)) continue;
    await discoverCoworkProjectDirs(join(dir, entry.name), depth + 1, result);
  }
}
