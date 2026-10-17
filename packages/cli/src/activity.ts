import { open, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import * as zlib from 'node:zlib';
import { dateKey, keepFilesModifiedSince, parseTs, resolveProjectFields, runWithConcurrency, type ProjectFields } from './scanners/utils.js';
import type { ReportRange } from './report.js';

const FILE_CONCURRENCY = 16;
const MAX_LINE_BYTES = 64 * 1024 * 1024; // 64 MB

export type ActivityConfidence = 'exact' | 'proxy';
export type ActivityKind =
  | 'user_message'
  | 'user_message_chars'
  | 'function_call'
  | 'custom_tool_call'
  | 'tool_call'
  | 'skill_call'
  | 'skill_proxy'
  | 'agent_call'
  | 'web_search'
  | 'tool_search'
  | 'image_generation'
  | 'task'
  | 'compaction'
  | 'rollback'
  | 'interruption'
  | 'mcp_tool_call';

export interface ActivityItem {
  usageDate: string;
  provider: 'openai' | 'anthropic';
  product: 'codex' | 'claude-code';
  source: string;
  project: string;
  projectDisplay?: string;
  projectAlias?: string;
  kind: ActivityKind;
  name: string;
  count: number;
  confidence: ActivityConfidence;
}

export interface ActivitySummary {
  key: string;
  label: string;
  count: number;
  exactCount: number;
  proxyCount: number;
}

export interface ActivityDailySummary {
  usageDate: string;
  exactCount: number;
  proxyCount: number;
  userMessageCount: number;
  userMessageChars: number;
}

export interface ActivityReport {
  range: ReportRange;
  rangeLabel: string;
  startDate?: string;
  endDate?: string;
  requestedDays: number;
  daysWithData: number;
  totals: {
    exactCount: number;
    proxyCount: number;
    userMessageCount: number;
    userMessageChars: number;
    filesScanned: number;
    sessionsScanned: number;
  };
  daily: ActivityDailySummary[];
  bySource: ActivitySummary[];
  byKind: ActivitySummary[];
  topTools: ActivitySummary[];
  topSkills: ActivitySummary[];
  topAgents: ActivitySummary[];
  items: ActivityItem[];
  notes: string[];
}

interface BuildActivityReportOptions {
  dates?: string[];
  projectAliases?: Record<string, string>;
  codexDir?: string;
  claudeProjectsDirs?: string[];
}

interface ScanStats {
  filesScanned: number;
  sessions: Set<string>;
  userMessages: Set<string>;
}

interface ScanResult {
  items: ActivityItem[];
  stats: ScanStats;
}

interface ActivityAccumulator {
  targetDates?: Set<string>;
  projectAliases?: Record<string, string>;
  items: Map<string, ActivityItem>;
  seen: Set<string>;
  stats: ScanStats;
}

interface CodexRecord {
  type?: string;
  timestamp?: string;
  payload?: {
    id?: string;
    type?: string;
    cwd?: string;
    originator?: string;
    source?: unknown;
    item?: CodexResponseItem;
    [key: string]: unknown;
  };
}

interface CodexResponseItem {
  type?: string;
  role?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  query?: string;
  content?: CodexContentBlock[] | string;
}

interface CodexContentBlock {
  type?: string;
  text?: string;
}

interface ClaudeRecord {
  type?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  uuid?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  promptSource?: unknown;
  origin?: { kind?: string };
  attachment?: {
    type?: string;
    prompt?: ClaudeContentBlock[] | string;
    origin?: { kind?: string };
    source_uuid?: string;
  };
  sourceToolAssistantUUID?: string;
  sourceToolUseID?: string;
  toolUseResult?: unknown;
  message?: {
    role?: string;
    content?: ClaudeContentBlock[] | string;
  };
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export async function buildActivityReport(
  range: ReportRange,
  options: BuildActivityReportOptions = {},
): Promise<ActivityReport> {
  const targetDates = options.dates ? new Set(options.dates) : undefined;
  const [codex, claude] = await Promise.all([
    scanCodexActivity(targetDates, options),
    scanClaudeActivity(targetDates, options),
  ]);
  const items = [...codex.items, ...claude.items].sort(sortActivityItems);
  const requestedDates = options.dates?.slice().sort();
  const itemDates = [...new Set(items.map(item => item.usageDate))].sort();
  const reportDates = requestedDates ?? itemDates;
  const daily = reportDates.map((usageDate) => {
    const dayItems = items.filter(item => item.usageDate === usageDate);
    return {
      usageDate,
      exactCount: sumByConfidence(dayItems, 'exact'),
      proxyCount: sumByConfidence(dayItems, 'proxy'),
      userMessageCount: sumKind(dayItems, 'user_message'),
      userMessageChars: sumKind(dayItems, 'user_message_chars'),
    };
  }).filter(day => requestedDates || day.exactCount > 0 || day.proxyCount > 0 || day.userMessageCount > 0);

  return {
    range,
    rangeLabel: getRangeLabel(range),
    startDate: reportDates[0],
    endDate: reportDates[reportDates.length - 1],
    requestedDays: reportDates.length,
    daysWithData: daily.filter(day => day.exactCount > 0 || day.proxyCount > 0).length,
    totals: {
      exactCount: sumByConfidence(items, 'exact'),
      proxyCount: sumByConfidence(items, 'proxy'),
      userMessageCount: codex.stats.userMessages.size + claude.stats.userMessages.size,
      userMessageChars: sumKind(items, 'user_message_chars'),
      filesScanned: codex.stats.filesScanned + claude.stats.filesScanned,
      sessionsScanned: new Set([...codex.stats.sessions, ...claude.stats.sessions]).size,
    },
    daily,
    bySource: summarize(items, item => item.source, item => item.source),
    byKind: summarize(items.filter(item => item.kind !== 'user_message_chars'), item => item.kind, item => labelKind(item.kind)),
    topTools: summarize(
      items.filter(item => isToolLikeKind(item.kind)),
      item => `${item.source}|${item.name}`,
      item => `${item.name} (${item.source})`,
      12,
    ),
    topSkills: summarize(
      items.filter(item => item.kind === 'skill_call' || item.kind === 'skill_proxy'),
      item => `${item.source}|${item.name}|${item.confidence}`,
      item => `${item.name} (${item.confidence === 'proxy' ? 'proxy' : item.source})`,
      12,
    ),
    topAgents: summarize(
      items.filter(item => item.kind === 'agent_call'),
      item => `${item.source}|${item.name}`,
      item => `${item.name} (${item.source})`,
      12,
    ),
    items,
    notes: [
      'Claude Code 的 Skill/Agent 来自结构化 tool_use，口径为 exact。',
      'Codex 的 skill_proxy 来自命令中读取 SKILL.md 的痕迹，只能表示代理信号。',
      '用户消息只计人工输入：剔除系统注入、子代理、自动化与定时任务；字数为去空白字符数，Claude Code 不含粘贴块。',
      'sync 会上传按日聚合后的 activity 指标，不上传原始消息内容。',
    ],
  };
}

export function renderActivityReport(report: ActivityReport, opts: { emoji: boolean; detail: boolean }): string {
  const lines: string[] = [];
  const title = opts.emoji ? '🧭 AIUsage Activity' : 'AIUsage Activity';
  lines.push(title);
  lines.push('─'.repeat(stripAnsi(title).length));
  lines.push(`周期      ${report.rangeLabel} (${report.startDate ?? '-'} ~ ${report.endDate ?? '-'})`);
  lines.push(`确切事件  ${fmt(report.totals.exactCount)}`);
  lines.push(`代理信号  ${fmt(report.totals.proxyCount)}`);
  lines.push(`用户消息  ${fmt(report.totals.userMessageCount)}`);
  lines.push(`用户字数  ${fmt(report.totals.userMessageChars)}`);
  lines.push(`Session   ${fmt(report.totals.sessionsScanned)}`);
  lines.push(`文件      ${fmt(report.totals.filesScanned)}`);

  if (report.daysWithData === 0) {
    lines.push('');
    lines.push('该范围无活动数据。');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('按来源');
  for (const row of report.bySource) {
    lines.push(`  ${row.label}: ${formatSummaryCount(row)}`);
  }

  lines.push('');
  lines.push('按类型');
  for (const row of report.byKind) {
    lines.push(`  ${row.label}: ${formatSummaryCount(row)}`);
  }

  if (report.topTools.length > 0) {
    lines.push('');
    lines.push('Top 工具');
    for (const row of report.topTools) {
      lines.push(`  ${row.label}: ${fmt(row.count)}`);
    }
  }

  if (report.topSkills.length > 0) {
    lines.push('');
    lines.push('Top Skill');
    for (const row of report.topSkills) {
      lines.push(`  ${row.label}: ${formatSummaryCount(row)}`);
    }
  }

  if (report.topAgents.length > 0) {
    lines.push('');
    lines.push('Top Subagent');
    for (const row of report.topAgents) {
      lines.push(`  ${row.label}: ${fmt(row.count)}`);
    }
  }

  if (opts.detail && report.daily.length > 0) {
    lines.push('');
    lines.push('每日');
    for (const day of report.daily) {
      lines.push(`  ${day.usageDate}: exact ${fmt(day.exactCount)} / proxy ${fmt(day.proxyCount)} / user ${fmt(day.userMessageCount)} (${fmt(day.userMessageChars)} 字)`);
    }
  }

  if (opts.detail) {
    lines.push('');
    lines.push('口径');
    for (const note of report.notes) lines.push(`  - ${note}`);
  }

  return lines.join('\n');
}

async function scanCodexActivity(
  targetDates: Set<string> | undefined,
  options: BuildActivityReportOptions,
): Promise<ScanResult> {
  const baseDir = options.codexDir ?? join(homedir(), '.codex');
  const acc = createAccumulator(targetDates, options.projectAliases);
  const files = await keepFilesModifiedSince(await collectCodexSessionFiles(baseDir), targetDates, path => path);
  acc.stats.filesScanned = files.length;
  await runWithConcurrency(files, FILE_CONCURRENCY, async filePath => {
    await processCodexFile(filePath, acc);
  });
  return finalizeActivity(acc);
}

async function processCodexFile(filePath: string, acc: ActivityAccumulator): Promise<void> {
  const compressed = filePath.endsWith('.zst');
  // Codex compresses old rollouts; zstd needs Node 22.15+, older runtimes skip them
  if (compressed && typeof zlib.createZstdDecompress !== 'function') return;
  let fh;
  try {
    fh = await open(filePath, 'r');
  } catch {
    return;
  }

  const fallbackSessionId = basename(filePath).replace(/\.jsonl(\.zst)?$/, '');
  let sessionId = fallbackSessionId;
  let projectFields: ProjectFields = { project: 'unknown', projectDisplay: 'unknown' };
  let automated = false;
  // Newer rollouts log typed text as item_completed/UserMessage, older ones as event_msg/user_message
  const itemMessages: CodexUserMessage[] = [];
  const eventMessages: CodexUserMessage[] = [];

  try {
    const stream = fh.createReadStream();
    const rl = createInterface({
      input: compressed ? stream.pipe(zlib.createZstdDecompress()) : stream.setEncoding('utf-8'),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) continue;

      let record: CodexRecord;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      if (record.type === 'session_meta') {
        const id = stringValue(record.payload?.id);
        if (id) sessionId = id;
        automated = isAutomatedCodexSession(record.payload);
        acc.stats.sessions.add(`codex:${sessionId}`);
        continue;
      }

      if (record.type === 'turn_context') {
        const cwd = stringValue(record.payload?.cwd);
        if (cwd) projectFields = resolveProjectFields(cwd, acc.projectAliases);
        continue;
      }

      const ts = parseTs(record.timestamp);
      if (!ts) continue;
      const usageDate = dateKey(ts);
      if (!acceptsDate(acc, usageDate)) continue;

      if (record.type === 'response_item') {
        handleCodexResponseItem(record.payload?.item ?? record.payload, usageDate, projectFields, sessionId, filePath, record.timestamp ?? '', acc);
        continue;
      }

      if (record.type === 'event_msg') {
        const message = codexUserMessage(record);
        if (message) {
          (record.payload?.type === 'item_completed' ? itemMessages : eventMessages)
            .push({ ...message, usageDate, projectFields });
          continue;
        }
        handleCodexEvent(record, usageDate, projectFields, sessionId, filePath, acc);
      }
    }
  } catch {
    // Truncated or corrupt file: keep what was read
  } finally {
    await fh.close();
  }

  if (automated) return;
  for (const message of itemMessages.length ? itemMessages : eventMessages) {
    const text = codexTypedText(message.text);
    if (!text) continue;
    addUserMessage(acc, {
      provider: 'openai',
      product: 'codex',
      usageDate: message.usageDate,
      projectFields: message.projectFields,
      sessionId,
      timestamp: message.timestamp,
      content: text,
      chars: countChars(text),
      fallbackKey: `${filePath}:${message.usageDate}:${sessionId}:user:${message.timestamp}`,
    });
  }
}

interface CodexUserMessage {
  timestamp: string;
  text: string;
  usageDate: string;
  projectFields: ProjectFields;
}

function codexUserMessage(record: CodexRecord): Omit<CodexUserMessage, 'usageDate' | 'projectFields'> | undefined {
  const payload = record.payload;
  if (payload?.type === 'user_message') {
    return { timestamp: record.timestamp ?? '', text: stringValue(payload.message) ?? '' };
  }
  if (payload?.type === 'item_completed' && payload.item?.type === 'UserMessage') {
    return { timestamp: record.timestamp ?? '', text: extractCodexMessageText(payload.item.content) ?? '' };
  }
  return undefined;
}

// codex exec runs and subagent threads (e.g. the guardian reviewer) are not typed by the user
function isAutomatedCodexSession(payload: CodexRecord['payload']): boolean {
  if (payload?.originator === 'codex_exec') return true;
  const source = payload?.source;
  return typeof source === 'object' && source !== null && 'subagent' in source;
}

const CODEX_MY_REQUEST = /^## My request[^\n]*:[ \t]*$/gm;
const CODEX_BROWSER_COMMENT = /^Comment:\n([\s\S]*?)(?=\n\n## User Comment|\n\n#|\nThe next image|$(?![\s\S]))/gm;

// Codex Desktop wraps typed text with context headers; keep only what the user wrote
export function codexTypedText(raw: string): string | undefined {
  let text = raw;
  const requests = [...raw.matchAll(CODEX_MY_REQUEST)];
  if (requests.length) {
    const last = requests[requests.length - 1];
    text = raw.slice(last.index! + last[0].length);
  } else if (raw.trimStart().startsWith('# Browser comments')) {
    text = [...raw.matchAll(CODEX_BROWSER_COMMENT)].map(m => m[1]).join('\n');
  }
  // Tag-led turns are injected context (environment, automation heartbeat…)
  if (text.trimStart().startsWith('<')) return undefined;
  return text.trim() ? text : undefined;
}

function handleCodexResponseItem(
  item: CodexResponseItem | undefined,
  usageDate: string,
  projectFields: ProjectFields,
  sessionId: string,
  filePath: string,
  timestamp: string,
  acc: ActivityAccumulator,
): void {
  if (!item?.type) return;
  const callId = item.call_id;
  const baseKey = callId ? `codex:${item.type}:${callId}` : `codex:${filePath}:${usageDate}:${item.type}:${item.name ?? ''}:${item.arguments ?? ''}`;

  // role=user messages also carry injected AGENTS.md / environment context; typed text comes from events
  if (item.type === 'message') return;

  if (item.type === 'function_call') {
    const name = item.name ?? 'unknown';
    const args = parseJsonObject(item.arguments);
    const kind: ActivityKind = name === 'spawn_agent' ? 'agent_call' : 'function_call';
    addActivity(acc, {
      usageDate,
      provider: 'openai',
      product: 'codex',
      projectFields,
      sessionId,
      kind,
      name: kind === 'agent_call' ? stringValue(args.agent_type) ?? name : name,
      confidence: 'exact',
      dedupeKey: baseKey,
    });

    for (const skillName of extractSkillProxyNames(item.arguments)) {
      addActivity(acc, {
        usageDate,
        provider: 'openai',
        product: 'codex',
        projectFields,
        sessionId,
        kind: 'skill_proxy',
        name: skillName,
        confidence: 'proxy',
        dedupeKey: `${baseKey}:skill:${skillName}`,
      });
    }
    return;
  }

  if (item.type === 'custom_tool_call') {
    addActivity(acc, {
      usageDate,
      provider: 'openai',
      product: 'codex',
      projectFields,
      sessionId,
      kind: 'custom_tool_call',
      name: item.name ?? 'unknown',
      confidence: 'exact',
      dedupeKey: baseKey,
    });
    return;
  }

  if (item.type === 'web_search_call' || item.type === 'tool_search_call' || item.type === 'image_generation_call') {
    addActivity(acc, {
      usageDate,
      provider: 'openai',
      product: 'codex',
      projectFields,
      sessionId,
      kind: item.type === 'web_search_call'
        ? 'web_search'
        : item.type === 'tool_search_call'
        ? 'tool_search'
        : 'image_generation',
      name: item.name ?? item.type,
      confidence: 'exact',
      dedupeKey: baseKey,
    });
  }
}

function handleCodexEvent(
  record: CodexRecord,
  usageDate: string,
  projectFields: ProjectFields,
  sessionId: string,
  filePath: string,
  acc: ActivityAccumulator,
): void {
  const payloadType = record.payload?.type;
  const kind = payloadType === 'task_started' || payloadType === 'task_complete'
    ? 'task'
    : payloadType === 'context_compacted'
    ? 'compaction'
    : payloadType === 'thread_rolled_back'
    ? 'rollback'
    : payloadType === 'turn_aborted'
    ? 'interruption'
    : payloadType === 'mcp_tool_call_end'
    ? 'mcp_tool_call'
    : undefined;
  if (!kind) return;

  const callId = stringValue(record.payload?.call_id);
  addActivity(acc, {
    usageDate,
    provider: 'openai',
    product: 'codex',
    projectFields,
    sessionId,
    kind,
    name: payloadType ?? kind,
    confidence: 'exact',
    dedupeKey: callId
      ? `codex:event:${callId}:${payloadType}`
      : `codex:event:${filePath}:${usageDate}:${sessionId}:${payloadType}:${record.timestamp ?? ''}`,
  });
}

async function scanClaudeActivity(
  targetDates: Set<string> | undefined,
  options: BuildActivityReportOptions,
): Promise<ScanResult> {
  const acc = createAccumulator(targetDates, options.projectAliases);
  const fileJobs: { filePath: string; projectFields: ProjectFields }[] = [];
  for (const baseDir of getClaudeProjectDirs(options.claudeProjectsDirs)) {
    let projectDirs;
    try {
      projectDirs = await readdir(baseDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const projectPath = join(baseDir, entry.name);
      const jsonlFiles: string[] = [];
      await walkJsonl(projectPath, jsonlFiles);
      const fields = resolveClaudeProject(projectPath, acc.projectAliases);
      for (const filePath of jsonlFiles) fileJobs.push({ filePath, projectFields: fields });
    }
  }

  const recentJobs = await keepFilesModifiedSince(fileJobs, targetDates, job => job.filePath);
  acc.stats.filesScanned = recentJobs.length;
  await runWithConcurrency(recentJobs, FILE_CONCURRENCY, async job => {
    await processClaudeFile(job.filePath, job.projectFields, acc);
  });
  return finalizeActivity(acc);
}

async function processClaudeFile(filePath: string, fallbackFields: ProjectFields, acc: ActivityAccumulator): Promise<void> {
  let fh;
  try {
    fh = await open(filePath, 'r');
  } catch {
    return;
  }

  const fallbackSessionId = basename(filePath).replace(/\.jsonl$/, '');

  try {
    const rl = createInterface({
      input: fh.createReadStream({ encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) continue;

      let record: ClaudeRecord;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const ts = parseTs(record.timestamp);
      if (!ts) continue;
      const usageDate = dateKey(ts);
      if (!acceptsDate(acc, usageDate)) continue;

      const sessionId = record.sessionId ?? fallbackSessionId;
      acc.stats.sessions.add(`claude:${sessionId}`);
      const projectFields = record.cwd ? resolveProjectFields(record.cwd, acc.projectAliases) : fallbackFields;

      const prompt = claudeHumanPrompt(record);
      if (prompt) {
        const typed = claudeTypedText(prompt.text);
        if (typed !== undefined) {
          addUserMessage(acc, {
            provider: 'anthropic',
            product: 'claude-code',
            usageDate,
            projectFields,
            sessionId,
            timestamp: record.timestamp ?? '',
            content: prompt.text,
            chars: countChars(typed),
            fallbackKey: `${filePath}:${usageDate}:${sessionId}:user:${record.timestamp ?? ''}`,
            id: prompt.id,
          });
        }
      }

      const blocks = Array.isArray(record.message?.content) ? record.message.content : [];

      for (const block of blocks) {
        if (block?.type !== 'tool_use') continue;
        const name = block.name ?? 'unknown';
        const kind = classifyClaudeTool(name);
        const metricName = getClaudeMetricName(name, block.input);
        const dedupeKey = block.id
          ? `claude:tool:${block.id}`
          : `claude:tool:${filePath}:${usageDate}:${sessionId}:${name}:${JSON.stringify(block.input ?? {})}`;
        addActivity(acc, {
          usageDate,
          provider: 'anthropic',
          product: 'claude-code',
          projectFields,
          sessionId,
          kind,
          name: metricName,
          confidence: 'exact',
          dedupeKey,
        });
      }
    }
  } finally {
    await fh.close();
  }
}

function createAccumulator(targetDates?: Set<string>, projectAliases?: Record<string, string>): ActivityAccumulator {
  return {
    targetDates,
    projectAliases,
    items: new Map(),
    seen: new Set(),
    stats: {
      filesScanned: 0,
      sessions: new Set(),
      userMessages: new Set(),
    },
  };
}

function finalizeActivity(acc: ActivityAccumulator): ScanResult {
  return {
    items: [...acc.items.values()],
    stats: acc.stats,
  };
}

function addActivity(
  acc: ActivityAccumulator,
  input: {
    usageDate: string;
    provider: 'openai' | 'anthropic';
    product: 'codex' | 'claude-code';
    projectFields: ProjectFields;
    sessionId: string;
    kind: ActivityKind;
    name: string;
    confidence: ActivityConfidence;
    dedupeKey: string;
    amount?: number;
  },
): void {
  const amount = input.amount ?? 1;
  if (acc.seen.has(input.dedupeKey)) return;
  acc.seen.add(input.dedupeKey);
  const source = `${input.provider}/${input.product}`;
  const key = [
    input.usageDate,
    source,
    input.projectFields.project,
    input.kind,
    input.name,
    input.confidence,
  ].join('|');
  const existing = acc.items.get(key);
  if (existing) {
    existing.count += amount;
    return;
  }
  acc.items.set(key, {
    usageDate: input.usageDate,
    provider: input.provider,
    product: input.product,
    source,
    project: input.projectFields.project,
    projectDisplay: input.projectFields.projectDisplay,
    projectAlias: input.projectFields.projectAlias,
    kind: input.kind,
    name: input.name,
    count: amount,
    confidence: input.confidence,
  });
}

function addUserMessage(
  acc: ActivityAccumulator,
  input: {
    provider: 'openai' | 'anthropic';
    product: 'codex' | 'claude-code';
    usageDate: string;
    projectFields: ProjectFields;
    sessionId: string;
    timestamp: string;
    content?: string;
    chars: number;
    fallbackKey: string;
    id?: string;
  },
): void {
  const source = `${input.provider}/${input.product}`;
  const normalized = normalizeMessageText(input.content);
  const key = input.id
    ? `${source}:user_message:${input.id}`
    : normalized
    ? `${source}:user_message:${input.sessionId}:${input.timestamp}:${normalized}`
    : `${source}:user_message:${input.fallbackKey}`;
  if (acc.stats.userMessages.has(key)) return;
  acc.stats.userMessages.add(key);
  addActivity(acc, {
    usageDate: input.usageDate,
    provider: input.provider,
    product: input.product,
    projectFields: input.projectFields,
    sessionId: input.sessionId,
    kind: 'user_message',
    name: 'user_message',
    confidence: 'exact',
    dedupeKey: `activity:${key}`,
  });
  if (input.chars > 0) {
    addActivity(acc, {
      usageDate: input.usageDate,
      provider: input.provider,
      product: input.product,
      projectFields: input.projectFields,
      sessionId: input.sessionId,
      kind: 'user_message_chars',
      name: 'user_message_chars',
      confidence: 'exact',
      dedupeKey: `activity:${key}:chars`,
      amount: input.chars,
    });
  }
}

function acceptsDate(acc: ActivityAccumulator, usageDate: string): boolean {
  return !acc.targetDates || acc.targetDates.has(usageDate);
}

async function collectCodexSessionFiles(baseDir: string): Promise<string[]> {
  const paths: string[] = [];
  try {
    const files = await readdir(join(baseDir, 'archived_sessions'));
    for (const file of files) {
      if (isCodexSessionFile(file)) paths.push(join(baseDir, 'archived_sessions', file));
    }
  } catch { /* ignore */ }
  await walkJsonl(join(baseDir, 'sessions'), paths, isCodexSessionFile);
  return paths;
}

function getClaudeProjectDirs(configured?: string[]): string[] {
  if (configured?.length) return configured;
  const envVar = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (envVar) {
    return envVar.split(',').map(p => p.trim()).filter(Boolean).map(p => join(p, 'projects'));
  }
  const home = homedir();
  return [
    join(home, '.config', 'claude', 'projects'),
    join(home, '.claude', 'projects'),
  ];
}

function isCodexSessionFile(name: string): boolean {
  return name.endsWith('.jsonl') || name.endsWith('.jsonl.zst');
}

async function walkJsonl(
  dir: string,
  result: string[],
  accept: (name: string) => boolean = name => name.endsWith('.jsonl'),
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJsonl(fullPath, result, accept);
    } else if (accept(entry.name)) {
      result.push(fullPath);
    }
  }
}

function resolveClaudeProject(projectPath: string, aliases?: Record<string, string>): ProjectFields {
  const rawName = basename(projectPath);
  const display = rawName.split('-').filter(Boolean).at(-1) || rawName || 'unknown';
  const alias = aliases?.[projectPath] ?? aliases?.[display];
  return {
    project: projectPath,
    projectDisplay: display,
    projectAlias: alias,
  };
}

function classifyClaudeTool(name: string): ActivityKind {
  if (name === 'Skill') return 'skill_call';
  if (name === 'Agent') return 'agent_call';
  if (name === 'WebSearch' || name === 'WebFetch') return 'web_search';
  if (name === 'ToolSearch') return 'tool_search';
  if (name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TaskList' || name === 'TaskStop') return 'task';
  return 'tool_call';
}

function getClaudeMetricName(toolName: string, input: Record<string, unknown> | undefined): string {
  if (toolName === 'Skill') return stringValue(input?.skill) ?? 'unknown';
  if (toolName === 'Agent') {
    return stringValue(input?.description)
      ?? stringValue(input?.subagent_type)
      ?? 'unknown';
  }
  return toolName;
}

// Human turns: typed prompts plus messages queued while the agent was busy
function claudeHumanPrompt(record: ClaudeRecord): { text: string; id?: string } | undefined {
  const attachment = record.attachment;
  if (attachment?.type === 'queued_command') {
    if (attachment.origin?.kind !== 'human') return undefined;
    return { text: extractClaudeMessageText(attachment.prompt) ?? '', id: attachment.source_uuid };
  }
  if (record.type !== 'user' || record.message?.role !== 'user') return undefined;
  if (record.isMeta || record.isSidechain || record.isCompactSummary || record.isVisibleInTranscriptOnly) return undefined;
  // Newer transcripts mark the author (desktop turns are human-origin even via SDK);
  // without it, drop headless SDK runs and system-injected turns
  if (record.origin) {
    if (record.origin.kind !== 'human') return undefined;
  } else if (record.promptSource === 'sdk' || record.promptSource === 'system') {
    return undefined;
  }
  if (record.toolUseResult || record.sourceToolAssistantUUID || record.sourceToolUseID) return undefined;
  const content = record.message.content;
  if (Array.isArray(content) && content.some(block => block?.type === 'tool_result')) return undefined;
  const text = extractClaudeMessageText(content);
  return text ? { text, id: record.uuid } : undefined;
}

const CLAUDE_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const CLAUDE_PASTE = /<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g;
const CLAUDE_PLACEHOLDER = /\[(?:Pasted text #\d+(?: \+\d+ lines)?|Image #\d+)\]/g;

// Typed text without reminders and pasted blocks; undefined for injected turns
// (slash command output, scheduled task, task notification…)
export function claudeTypedText(raw: string): string | undefined {
  const text = raw.replace(CLAUDE_REMINDER, '').replace(CLAUDE_PASTE, '');
  const trimmed = text.trimStart();
  if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('Caveat:') || trimmed.startsWith('[Request interrupted')) {
    return undefined;
  }
  return text.replace(CLAUDE_PLACEHOLDER, '');
}

// Non-whitespace code points: one per CJK character or Latin letter
export function countChars(text: string): number {
  return [...text.replace(/\s+/g, '')].length;
}

function extractCodexMessageText(content: CodexContentBlock[] | string | undefined): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map(block => stringValue(block.text))
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function extractClaudeMessageText(content: ClaudeContentBlock[] | string | undefined): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(block => block?.type === 'text')
    .map(block => stringValue(block.text))
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function normalizeMessageText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized || undefined;
}

function extractSkillProxyNames(rawArguments?: string): string[] {
  if (!rawArguments) return [];
  const args = parseJsonObject(rawArguments);
  const command = stringValue(args.cmd) ?? stringValue(args.command) ?? '';
  if (!command.includes('SKILL.md')) return [];
  const names = new Set<string>();
  for (const match of command.matchAll(/([^\s'"]*SKILL\.md)/g)) {
    names.add(skillNameFromPath(match[1]));
  }
  return [...names];
}

function parseJsonObject(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function skillNameFromPath(rawPath: string): string {
  const cleaned = rawPath.replace(/^[`'"]+|[`'"]+$/g, '');
  const parts = cleaned.split('/').filter(Boolean);
  const idx = parts.lastIndexOf('SKILL.md');
  const name = idx > 0 ? parts[idx - 1] : undefined;
  if (!name || name === '$d' || name === 's#') return 'unknown-skill';
  return name;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function summarize(
  items: ActivityItem[],
  keyFn: (item: ActivityItem) => string,
  labelFn: (item: ActivityItem) => string,
  limit?: number,
): ActivitySummary[] {
  const grouped = new Map<string, ActivitySummary>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = grouped.get(key);
    if (existing) {
      existing.count += item.count;
      if (item.confidence === 'exact') existing.exactCount += item.count;
      else existing.proxyCount += item.count;
      continue;
    }
    grouped.set(key, {
      key,
      label: labelFn(item),
      count: item.count,
      exactCount: item.confidence === 'exact' ? item.count : 0,
      proxyCount: item.confidence === 'proxy' ? item.count : 0,
    });
  }
  const rows = [...grouped.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return limit ? rows.slice(0, limit) : rows;
}

function sumByConfidence(items: ActivityItem[], confidence: ActivityConfidence): number {
  return items.reduce((sum, item) => sum + (!isUserMessageKind(item.kind) && item.confidence === confidence ? item.count : 0), 0);
}

function sumKind(items: ActivityItem[], kind: ActivityKind): number {
  return items.reduce((sum, item) => sum + (item.kind === kind ? item.count : 0), 0);
}

function isUserMessageKind(kind: ActivityKind): boolean {
  return kind === 'user_message' || kind === 'user_message_chars';
}

function isToolLikeKind(kind: ActivityKind): boolean {
  return kind === 'function_call'
    || kind === 'custom_tool_call'
    || kind === 'tool_call'
    || kind === 'web_search'
    || kind === 'tool_search'
    || kind === 'image_generation'
    || kind === 'mcp_tool_call';
}

function labelKind(kind: ActivityKind): string {
  switch (kind) {
    case 'user_message': return 'User Message';
    case 'user_message_chars': return 'User Message Chars';
    case 'function_call': return 'Function Call';
    case 'custom_tool_call': return 'Custom Tool Call';
    case 'tool_call': return 'Tool Call';
    case 'skill_call': return 'Skill';
    case 'skill_proxy': return 'Skill Proxy';
    case 'agent_call': return 'Subagent';
    case 'web_search': return 'Web Search';
    case 'tool_search': return 'Tool Search';
    case 'image_generation': return 'Image Generation';
    case 'task': return 'Task';
    case 'compaction': return 'Context Compaction';
    case 'rollback': return 'Rollback';
    case 'interruption': return 'Interruption';
    case 'mcp_tool_call': return 'MCP Tool';
  }
}

function getRangeLabel(range: ReportRange): string {
  switch (range) {
    case '7d': return '最近 7 天';
    case '1m': return '最近 30 天';
    case '3m': return '最近 90 天';
    case '6m': return '最近 180 天';
    case 'all': return '全部历史';
    case 'today': return '今天';
  }
}

function sortActivityItems(a: ActivityItem, b: ActivityItem): number {
  return a.usageDate.localeCompare(b.usageDate)
    || a.source.localeCompare(b.source)
    || a.kind.localeCompare(b.kind)
    || a.name.localeCompare(b.name);
}

function formatSummaryCount(row: ActivitySummary): string {
  if (row.proxyCount === 0) return fmt(row.exactCount);
  if (row.exactCount === 0) return `${fmt(row.proxyCount)} proxy`;
  return `${fmt(row.exactCount)} exact / ${fmt(row.proxyCount)} proxy`;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
