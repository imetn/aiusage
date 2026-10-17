import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { calculateCost, type IngestBreakdown } from '@aiusage/shared';
import { fileModifiedTs, keepFilesModifiedSince, normalizeModelName, runWithConcurrency, resolveProjectFields, type ProjectFields } from './utils.js';

const FILE_CONCURRENCY = 16;
const MAX_LINE_BYTES = 64 * 1024 * 1024; // 64 MB
type CodexServiceTier = 'fast' | 'priority' | null;

interface CodexRecord {
  type?: string;
  timestamp?: string;
  payload?: CodexPayload;
}

interface CodexPayload {
  type?: string;
  model?: string;
  model_name?: string;
  model_info?: { slug?: string };
  cwd?: string;
  id?: string;
  forked_from_id?: string;
  source?: unknown;
  thread_source?: string;
  turn_id?: string;
  started_at?: number;
  info?: {
    model?: string;
    model_name?: string;
    last_token_usage?: TokenUsage;
    total_token_usage?: TokenUsage;
  };
}

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexTotals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

interface CodexFileState {
  currentModel: string;
  projectFields: ProjectFields;
  hasSessionWorkspace: boolean;
  previousTotals?: CodexTotals;
  sessionIdFromMeta?: string;
  sessionForkedFromId?: string;
  forkedChildSessionId?: string;
  forkedChildReplaySessionId?: string;
  waitingForChildTurn: boolean;
  inheritedBaseline?: CodexTotals;
  inheritedReportedTotal?: number;
  taskStartedTurnIds: Set<string>;
  childIsUserFork: boolean;
}

interface CodexUsageEvent {
  usageDate: string;
  signature: string;
  model: string;
  projectFields: ProjectFields;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  costUSD?: number;
  pricingVersion?: string;
}

export async function scanCodex(
  targetDate: string,
  codexDir?: string,
  projectAliases?: Record<string, string>,
): Promise<IngestBreakdown[]> {
  const groupedByDate = await scanCodexDates([targetDate], codexDir, projectAliases);
  return groupedByDate.get(targetDate) ?? [];
}

export async function scanCodexDates(
  targetDates: string[],
  codexDir?: string,
  projectAliases?: Record<string, string>,
): Promise<Map<string, IngestBreakdown[]>> {
  const targetDateSet = new Set(targetDates);
  const groupedByDate = new Map<string, Map<string, IngestBreakdown>>();
  for (const targetDate of targetDateSet) groupedByDate.set(targetDate, new Map());

  const baseDir = codexDir ?? join(homedir(), '.codex');
  const serviceTier = await detectCodexServiceTier(baseDir);

  const sessionFiles = await keepFilesModifiedSince(await collectSessionFiles(baseDir), targetDateSet, path => path);
  if (sessionFiles.length === 0) {
    return new Map([...targetDateSet].map((targetDate) => [targetDate, []]));
  }

  // 文件并发解析、按稳定路径顺序合并：既保留扫描速度，也让 fork 重放的
  // first-wins 归属不受异步完成顺序影响。
  const eventsByFile: CodexUsageEvent[][] = Array.from({ length: sessionFiles.length }, () => []);
  await runWithConcurrency(sessionFiles, FILE_CONCURRENCY, async (filePath, index) => {
    eventsByFile[index] = await processCodexFile(filePath, projectAliases, serviceTier);
  });

  // 跨文件去重，但 key 必须带 session/fork scope；纯 token 数值全局去重会误杀独立会话。
  const globalSeenSigs = new Set<string>();
  for (const events of eventsByFile) {
    for (const event of events) {
      if (globalSeenSigs.has(event.signature)) continue;
      globalSeenSigs.add(event.signature);
      if (!targetDateSet.has(event.usageDate)) continue;
      mergeCodexEvent(groupedByDate, event);
    }
  }

  return new Map(
    [...groupedByDate.entries()].map(([usageDate, grouped]) => [usageDate, [...grouped.values()]]),
  );
}

/** 流式逐行读取单个 Codex JSONL 文件 */
async function processCodexFile(
  filePath: string,
  projectAliases: Record<string, string> | undefined,
  serviceTier: CodexServiceTier,
): Promise<CodexUsageEvent[]> {
  const events: CodexUsageEvent[] = [];
  const input = createReadStream(filePath, { encoding: 'utf-8' });
  try {
    const rl = createInterface({
      input,
      crlfDelay: Infinity,
    });

    const fileSessionId = basename(filePath, '.jsonl');
    const fallbackTs = await fileModifiedTs(filePath);
    const state: CodexFileState = {
      currentModel: 'unknown',
      projectFields: { project: 'unknown', projectDisplay: 'unknown' },
      hasSessionWorkspace: false,
      waitingForChildTurn: false,
      taskStartedTurnIds: new Set(),
      childIsUserFork: false,
    };

    for await (const line of rl) {
      if (!line) continue;

      // 大行保护
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) continue;

      let record: CodexRecord;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const payload = record.payload;
      if (!payload) continue;
      const payloadModel = extractCodexModel(payload);
      const isTokenCount = record.type === 'event_msg' && payload.type === 'token_count';

      // 子会话文件会先复制父会话历史。保持 child 的 workspace/session 状态，
      // 直到能确定自己的 turn_context，再开始计数。
      if (state.waitingForChildTurn) {
        if (record.type === 'turn_context' && childTurnStartsOwnSession(state, payload.turn_id)) {
          state.waitingForChildTurn = false;
          state.forkedChildReplaySessionId = undefined;
          state.taskStartedTurnIds.clear();
          state.childIsUserFork = false;
          state.sessionIdFromMeta = state.forkedChildSessionId ?? state.sessionIdFromMeta;
        } else {
          if (record.type === 'event_msg' && payload.type === 'task_started'
            && childTaskStartsOwnSession(state, payload.turn_id, payload.started_at)) {
            if (payload.turn_id) state.taskStartedTurnIds.add(payload.turn_id);
          }
          if (record.type === 'session_meta' && payload.id
            && payload.id !== state.forkedChildSessionId) {
            state.forkedChildReplaySessionId = payload.id;
          }
          if (isTokenCount) rememberInheritedBaseline(state, payload.info);
          continue;
        }
      }

      if (record.type === 'session_meta') {
        const sessionId = payload.id?.trim();
        if (sessionId) state.sessionIdFromMeta = sessionId;
        const forkParent = payload.forked_from_id?.trim() ?? forkParentFromSource(payload.source);
        if (forkParent) {
          const repeatedActiveChild = !state.waitingForChildTurn
            && Boolean(sessionId)
            && state.forkedChildSessionId === sessionId;
          state.sessionForkedFromId = forkParent;
          state.forkedChildSessionId = sessionId;
          if (!repeatedActiveChild) {
            state.waitingForChildTurn = true;
            state.forkedChildReplaySessionId = undefined;
            state.inheritedBaseline = undefined;
            state.inheritedReportedTotal = undefined;
            state.taskStartedTurnIds.clear();
            state.childIsUserFork = payload.thread_source === 'user';
          }
        }
        if (payload.cwd) {
          state.projectFields = resolveProjectFields(payload.cwd, projectAliases);
          state.hasSessionWorkspace = true;
        }
        continue;
      }

      if (record.type === 'turn_context') {
        if (payloadModel && payloadModel !== '<synthetic>') {
          state.currentModel = applyCodexServiceTier(normalizeModelName(payloadModel), serviceTier);
        }
        if (payload.cwd && !state.hasSessionWorkspace) {
          state.projectFields = resolveProjectFields(payload.cwd, projectAliases);
        }
        continue;
      }

      if (!isTokenCount) continue;
      const info = payload.info;
      if (!info?.total_token_usage && !info?.last_token_usage) continue;

      if (payloadModel && payloadModel !== '<synthetic>') {
        state.currentModel = applyCodexServiceTier(normalizeModelName(payloadModel), serviceTier);
      }
      const ts = parseTimestamp(record.timestamp) ?? fallbackTs;
      if (!ts) continue;
      const usageDate = toDateKey(ts);

      const total = info.total_token_usage ? totalsFromUsage(info.total_token_usage) : undefined;
      const last = info.last_token_usage ? totalsFromUsage(info.last_token_usage) : undefined;
      if (shouldSkipInheritedSnapshot(state, info.total_token_usage, total)) continue;
      state.inheritedBaseline = undefined;
      state.inheritedReportedTotal = undefined;

      const parsed = resolveCodexIncrement(total, last, state.previousTotals);
      if (!parsed) continue;
      if (!parsed.tokens) {
        state.previousTotals = parsed.nextTotals;
        continue;
      }
      const { tokens, nextTotals } = parsed;
      const cachedInput = Math.min(tokens.cached, tokens.input);
      const cacheWriteInput = Math.min(tokens.cacheWrite, Math.max(tokens.input - cachedInput, 0));
      const nonCachedInput = Math.max(tokens.input - cachedInput - cacheWriteInput, 0);
      // Codex output_tokens already includes reasoning_output_tokens. Store the
      // two components without overlap so reports can safely add them together.
      const reasoning = Math.min(tokens.reasoning, tokens.output);
      const output = Math.max(tokens.output - reasoning, 0);
      if (nonCachedInput + cachedInput + cacheWriteInput + output + reasoning === 0) continue;
      state.previousTotals = nextTotals;

      const dedupScope = state.sessionForkedFromId
        ?? state.sessionIdFromMeta
        ?? fileSessionId;
      const signature = total
        ? `codex|${dedupScope}|${state.currentModel}|${total.input}|${total.cached}|${total.cacheWrite}|${total.output}|${total.reasoning}`
        : `codex|${dedupScope}|${state.currentModel}|${ts.getTime()}|${tokens.input}|${tokens.cached}|${tokens.cacheWrite}|${tokens.output}|${tokens.reasoning}`;

      const eventCost = calculateCost('openai', 'codex', state.currentModel, {
        inputTokens: nonCachedInput,
        cachedInputTokens: cachedInput,
        cacheWriteTokens: cacheWriteInput,
        // Reasoning is billed at the output rate, so pricing still uses the
        // inclusive raw Codex output total.
        outputTokens: tokens.output,
      });
      const exactEventCost = eventCost.costStatus === 'exact' ? eventCost.estimatedCostUsd : undefined;
      events.push({
        usageDate,
        signature,
        model: state.currentModel,
        projectFields: { ...state.projectFields },
        inputTokens: nonCachedInput,
        cachedInputTokens: cachedInput,
        cacheWriteTokens: cacheWriteInput,
        outputTokens: output,
        reasoningOutputTokens: reasoning,
        costUSD: exactEventCost,
        pricingVersion: exactEventCost !== undefined ? eventCost.pricingVersion : undefined,
      });
    }
  } catch {
    // 文件在扫描期间被移动、归档或损坏时跳过该文件。
  } finally {
    input.destroy();
  }
  return events;
}

function mergeCodexEvent(
  groupedByDate: Map<string, Map<string, IngestBreakdown>>,
  event: CodexUsageEvent,
): void {
  const grouped = groupedByDate.get(event.usageDate);
  if (!grouped) return;
  const key = `${event.model}|${event.projectFields.project}`;
  const existing = grouped.get(key);
  if (existing) {
    existing.eventCount += 1;
    existing.inputTokens += event.inputTokens;
    existing.cachedInputTokens += event.cachedInputTokens;
    existing.cacheWriteTokens += event.cacheWriteTokens;
    existing.outputTokens += event.outputTokens;
    existing.reasoningOutputTokens += event.reasoningOutputTokens;
    if (event.costUSD !== undefined) {
      existing.costUSD = (existing.costUSD ?? 0) + event.costUSD;
      existing.pricingVersion = event.pricingVersion;
    }
    return;
  }

  const breakdown: IngestBreakdown = {
    provider: 'openai',
    product: 'codex',
    channel: 'cli',
    model: event.model,
    project: event.projectFields.project,
    projectDisplay: event.projectFields.projectDisplay,
    projectAlias: event.projectFields.projectAlias,
    eventCount: 1,
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    outputTokens: event.outputTokens,
    reasoningOutputTokens: event.reasoningOutputTokens,
  };
  if (event.costUSD !== undefined) {
    breakdown.costUSD = event.costUSD;
    breakdown.pricingVersion = event.pricingVersion;
  }
  grouped.set(key, breakdown);
}

function forkParentFromSource(source: unknown): string | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const subagent = (source as Record<string, unknown>).subagent;
  if (!subagent || typeof subagent !== 'object' || Array.isArray(subagent)) return undefined;
  const spawn = (subagent as Record<string, unknown>).thread_spawn;
  if (!spawn || typeof spawn !== 'object' || Array.isArray(spawn)) return undefined;
  const parent = (spawn as Record<string, unknown>).parent_thread_id;
  return typeof parent === 'string' && parent.trim() ? parent.trim() : undefined;
}

function clampToken(value: number | undefined): number {
  return Math.max(Number.isFinite(value) ? value! : 0, 0);
}

function extractCodexModel(payload: CodexPayload): string | undefined {
  return payload.model
    ?? payload.model_name
    ?? payload.model_info?.slug
    ?? payload.info?.model
    ?? payload.info?.model_name;
}

function totalsFromUsage(usage: TokenUsage): CodexTotals {
  return {
    input: clampToken(usage.input_tokens),
    cached: Math.max(
      clampToken(usage.cached_input_tokens),
      clampToken(usage.cache_read_input_tokens),
    ),
    cacheWrite: clampToken(usage.cache_write_input_tokens),
    output: clampToken(usage.output_tokens),
    reasoning: clampToken(usage.reasoning_output_tokens),
  };
}

function totalsEqual(a: CodexTotals, b: CodexTotals): boolean {
  return a.input === b.input
    && a.cached === b.cached
    && a.cacheWrite === b.cacheWrite
    && a.output === b.output
    && a.reasoning === b.reasoning;
}

function totalsDelta(current: CodexTotals, previous: CodexTotals): CodexTotals | undefined {
  if (current.input < previous.input || current.cached < previous.cached || current.cacheWrite < previous.cacheWrite
    || current.output < previous.output || current.reasoning < previous.reasoning) return undefined;
  return {
    input: current.input - previous.input,
    cached: current.cached - previous.cached,
    cacheWrite: current.cacheWrite - previous.cacheWrite,
    output: current.output - previous.output,
    reasoning: current.reasoning - previous.reasoning,
  };
}

function totalsAdd(a: CodexTotals, b: CodexTotals): CodexTotals {
  return {
    input: a.input + b.input,
    cached: a.cached + b.cached,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

function totalsSum(value: CodexTotals): number {
  return value.input + value.cached + value.cacheWrite + value.output + value.reasoning;
}

function looksLikeStaleRegression(current: CodexTotals, previous: CodexTotals, last: CodexTotals): boolean {
  const previousSum = totalsSum(previous);
  const currentSum = totalsSum(current);
  const lastSum = totalsSum(last);
  if (previousSum <= 0 || currentSum <= 0 || lastSum <= 0) return false;
  return currentSum * 100 >= previousSum * 98 || currentSum + lastSum * 2 >= previousSum;
}

function resolveCodexIncrement(
  total: CodexTotals | undefined,
  last: CodexTotals | undefined,
  previous: CodexTotals | undefined,
): { tokens?: CodexTotals; nextTotals?: CodexTotals } | undefined {
  if (total && last && previous) {
    if (totalsEqual(total, previous)) return undefined;
    if (!totalsDelta(total, previous) && looksLikeStaleRegression(total, previous, last)) return undefined;
    return { tokens: last, nextTotals: total };
  }
  if (total && last) return { tokens: last, nextTotals: total };
  if (total && previous) {
    if (totalsEqual(total, previous)) return undefined;
    const delta = totalsDelta(total, previous);
    return delta ? { tokens: delta, nextTotals: total } : { nextTotals: total };
  }
  if (total) return { tokens: total, nextTotals: total };
  if (last && previous) return { tokens: last, nextTotals: totalsAdd(previous, last) };
  if (last) return { tokens: last };
  return undefined;
}

function rememberInheritedBaseline(
  state: CodexFileState,
  info: CodexPayload['info'],
): void {
  const usage = info?.total_token_usage;
  if (!usage) return;
  const totals = totalsFromUsage(usage);
  state.previousTotals = totals;
  state.inheritedBaseline = totals;
  state.inheritedReportedTotal = reportedTotalTokens(usage);
}

function shouldSkipInheritedSnapshot(
  state: CodexFileState,
  usage: TokenUsage | undefined,
  totals: CodexTotals | undefined,
): boolean {
  const reported = usage ? reportedTotalTokens(usage) : undefined;
  if (reported != null && state.inheritedReportedTotal != null
    && reported <= state.inheritedReportedTotal) return true;
  const baseline = state.inheritedBaseline;
  return Boolean(totals && baseline
    && totals.input <= baseline.input
    && totals.cached <= baseline.cached
    && totals.cacheWrite <= baseline.cacheWrite
    && totals.output <= baseline.output
    && totals.reasoning <= baseline.reasoning);
}

function reportedTotalTokens(usage: TokenUsage): number | undefined {
  return typeof usage.total_tokens === 'number' && usage.total_tokens >= 0
    ? usage.total_tokens
    : undefined;
}

function childTurnStartsOwnSession(state: CodexFileState, turnId: string | undefined): boolean {
  if (!state.forkedChildReplaySessionId) return true;
  const childId = state.forkedChildSessionId;
  if (!childId) return true;
  const childKey = uuidV7OrderKey(childId);
  if (!turnId || !childKey) return true;
  const turnKey = uuidV7OrderKey(turnId);
  if (!turnKey) return state.childIsUserFork || state.taskStartedTurnIds.has(turnId);
  const turnMs = turnKey.slice(0, 12);
  const childMs = childKey.slice(0, 12);
  if (turnMs > childMs) return true;
  if (turnMs < childMs) return false;
  return state.childIsUserFork || state.taskStartedTurnIds.has(turnId);
}

function childTaskStartsOwnSession(
  state: CodexFileState,
  turnId: string | undefined,
  startedAt: number | undefined,
): boolean {
  const childId = state.forkedChildSessionId;
  if (!turnId || !childId) return false;
  const childKey = uuidV7OrderKey(childId);
  if (!childKey) return true;
  const turnKey = uuidV7OrderKey(turnId);
  if (turnKey) return turnKey.slice(0, 12) >= childKey.slice(0, 12);
  const childStartedMs = Number.parseInt(childKey.slice(0, 12), 16);
  return Number.isFinite(startedAt) && startedAt! >= Math.floor(childStartedMs / 1_000);
}

function uuidV7OrderKey(id: string): string | undefined {
  const parts = id.split('-');
  if (parts.length !== 5 || parts[0]?.length !== 8 || parts[1]?.length !== 4
    || parts[2]?.length !== 4 || parts[3]?.length !== 4 || parts[4]?.length !== 12
    || !parts[2]?.startsWith('7') || !parts.every(part => /^[0-9a-f]+$/i.test(part))) return undefined;
  return parts.join('').toLowerCase();
}

async function collectSessionFiles(baseDir: string): Promise<string[]> {
  // 与 Codex 本身的生命周期一致：活动会话优先，归档副本随后；各目录
  // 内按路径排序，确保重复事件的 workspace 归属稳定。
  const activePaths: string[] = [];
  const sessionsDir = join(baseDir, 'sessions');
  await walkDir(sessionsDir, activePaths);
  activePaths.sort();

  const archivedPaths: string[] = [];
  await walkDir(join(baseDir, 'archived_sessions'), archivedPaths);
  archivedPaths.sort();

  return [...activePaths, ...archivedPaths];
}

async function detectCodexServiceTier(baseDir: string): Promise<CodexServiceTier> {
  let config = '';
  try {
    config = await readFile(join(baseDir, 'config.toml'), 'utf-8');
  } catch {
    return null;
  }

  const serviceTier = config.match(/^\s*service_tier\s*=\s*["']([^"']+)["']/m)?.[1]?.trim().toLowerCase();
  if (serviceTier === 'priority') return 'priority';
  if (serviceTier === 'fast') return 'fast';

  const fastMode = config.match(/^\s*fast_mode\s*=\s*(true|false)\s*$/m)?.[1];
  return fastMode === 'true' ? 'fast' : null;
}

function applyCodexServiceTier(model: string, serviceTier: CodexServiceTier): string {
  if (!serviceTier) return model;
  if (model.endsWith('-fast') || model.endsWith('-priority')) return model;
  const supportsFast = model === 'gpt-6-astra' || model === 'gpt-6-sol' || model === 'gpt-6-luna'
    || model === 'gpt-5.5' || model === 'gpt-5.4';
  const supportsPriority =
    model === 'gpt-5.6' ||
    model === 'gpt-5.6-sol' ||
    model === 'gpt-5.6-terra' ||
    model === 'gpt-5.6-luna' ||
    supportsFast;
  if ((serviceTier === 'fast' && supportsFast) || (serviceTier === 'priority' && supportsPriority)) {
    return `${model}-${serviceTier}`;
  }
  return model;
}

async function walkDir(dir: string, result: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, result);
    } else if (entry.name.endsWith('.jsonl')) {
      result.push(fullPath);
    }
  }
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
