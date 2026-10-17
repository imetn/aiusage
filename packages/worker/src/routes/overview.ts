import { PUBLIC_READ_CACHE_HEADERS, jsonError, jsonOk } from '../utils/response.js';
import { toPublicProjectName } from '../utils/privacy.js';
import type { Env } from '../types.js';
import type { OverviewComparisonPayload } from '@aiusage/shared';

export const TOTAL_TOKENS_SQL = `
  COALESCE(b.input_tokens, 0) +
  COALESCE(b.cached_input_tokens, 0) +
  COALESCE(b.cache_write_tokens, 0) +
  COALESCE(b.output_tokens, 0) +
  COALESCE(b.reasoning_output_tokens, 0)
`;

const PROJECT_DISPLAY_SQL = `COALESCE(b.project_alias, b.project_display)`;
const ACTIVITY_PROJECT_DISPLAY_SQL = `COALESCE(a.project_alias, a.project_display)`;
const USER_MESSAGE_KINDS = `('user_message', 'user_message_chars')`;

export type FilterKey = 'deviceId' | 'provider' | 'product' | 'channel' | 'model' | 'project';

export interface DashboardFilters {
  minDate: string | null;
  maxDate: string | null;
  rangeDays: number | null;
  range: string;
  deviceId: string[];
  provider: string[];
  product: string[];
  channel: string[];
  model: string[];
  project: string[];
}

export interface WhereParts {
  whereClause: string;
  params: (string | number)[];
}

interface FacetItem {
  value: string;
  label: string;
  estimatedCostUsd: number;
  eventCount: number;
}

export async function handleOverview(url: URL, env: Env): Promise<Response> {
  const filters = parseFilters(url);
  if (!filters) return jsonError(400, 'INVALID_PAYLOAD', 'Invalid range parameter', true);

  const where = buildWhere(filters);
  const previousFilters = buildPreviousFilters(filters);

  // 热力图固定查最近 365 天（不受 range 过滤器影响，但保留 device/provider 等维度过滤）
  const heatmapMinDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 364);
    return d.toISOString().split('T')[0];
  })();
  const heatmapWhere = buildWhere({ ...filters, minDate: heatmapMinDate, maxDate: todayDateString(), rangeDays: 365, range: '365d' });

  const [
    summary,
    trendRows,
    providerTrendRows,
    tokenRows,
    modelRows,
    channelRows,
    flowRows,
    heatmapRows,
    devices,
    providers,
    products,
    channels,
    models,
    projects,
    interactionMetrics,
    comparison,
  ] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(DISTINCT b.usage_date) AS active_days,
        COALESCE(SUM(b.event_count), 0) AS total_events,
        COALESCE(SUM(b.session_count), 0) AS total_sessions,
        COALESCE(SUM(CASE WHEN b.estimated_cost_usd > 0 THEN b.event_count ELSE 0 END), 0) AS cost_bearing_events,
        COALESCE(SUM(b.estimated_cost_usd), 0) AS total_cost_usd
      FROM daily_usage_breakdown b
      ${where.whereClause}
    `).bind(...where.params).first<{
      active_days: number;
      total_events: number;
      total_sessions: number;
      cost_bearing_events: number;
      total_cost_usd: number;
    }>(),
    env.DB.prepare(`
      SELECT
        b.usage_date,
        COALESCE(SUM(b.event_count), 0) AS event_count,
        COALESCE(SUM(b.estimated_cost_usd), 0) AS estimated_cost_usd
      FROM daily_usage_breakdown b
      ${where.whereClause}
      GROUP BY b.usage_date
      ORDER BY b.usage_date
    `).bind(...where.params).all<{
      usage_date: string;
      event_count: number;
      estimated_cost_usd: number;
    }>(),
    env.DB.prepare(`
      SELECT
        b.usage_date,
        b.provider,
        COALESCE(SUM(b.estimated_cost_usd), 0) AS estimated_cost_usd
      FROM daily_usage_breakdown b
      ${where.whereClause}
      GROUP BY b.usage_date, b.provider
      ORDER BY b.usage_date, b.provider
    `).bind(...where.params).all<{
      usage_date: string;
      provider: string;
      estimated_cost_usd: number;
    }>(),
    env.DB.prepare(`
      SELECT
        b.usage_date,
        COALESCE(SUM(b.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(b.cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(b.cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(b.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(b.reasoning_output_tokens), 0) AS reasoning_output_tokens
      FROM daily_usage_breakdown b
      ${where.whereClause}
      GROUP BY b.usage_date
      ORDER BY b.usage_date
    `).bind(...where.params).all<{
      usage_date: string;
      input_tokens: number;
      cached_input_tokens: number;
      cache_write_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
    }>(),
    env.DB.prepare(`
      SELECT
        b.model AS value,
        COALESCE(SUM(b.estimated_cost_usd), 0) AS estimated_cost_usd,
        COALESCE(SUM(b.event_count), 0) AS event_count
      FROM daily_usage_breakdown b
      ${where.whereClause}
      GROUP BY b.model
      HAVING b.model IS NOT NULL AND b.model != ''
      ORDER BY estimated_cost_usd DESC, value ASC
    `).bind(...where.params).all<{
      value: string;
      estimated_cost_usd: number;
      event_count: number;
    }>(),
    env.DB.prepare(`
      SELECT
        b.channel AS value,
        COALESCE(SUM(b.estimated_cost_usd), 0) AS estimated_cost_usd,
        COALESCE(SUM(b.event_count), 0) AS event_count
      FROM daily_usage_breakdown b
      ${where.whereClause}
      GROUP BY b.channel
      HAVING b.channel IS NOT NULL AND b.channel != ''
      ORDER BY estimated_cost_usd DESC, value ASC
    `).bind(...where.params).all<{
      value: string;
      estimated_cost_usd: number;
      event_count: number;
    }>(),
    env.DB.prepare(`
      SELECT
        b.model,
        ${PROJECT_DISPLAY_SQL} AS project,
        COALESCE(SUM(${TOTAL_TOKENS_SQL}), 0) AS total_tokens
      FROM daily_usage_breakdown b
      ${where.whereClause}
      GROUP BY b.model, ${PROJECT_DISPLAY_SQL}
      HAVING COALESCE(SUM(${TOTAL_TOKENS_SQL}), 0) > 0
      ORDER BY total_tokens DESC, b.model ASC, project ASC
    `).bind(...where.params).all<{
      model: string;
      project: string;
      total_tokens: number;
    }>(),
    env.DB.prepare(`
      SELECT
        b.usage_date,
        COALESCE(SUM(${TOTAL_TOKENS_SQL}), 0) AS total_tokens,
        COALESCE(SUM(b.estimated_cost_usd), 0) AS estimated_cost_usd
      FROM daily_usage_breakdown b
      ${heatmapWhere.whereClause}
      GROUP BY b.usage_date
      ORDER BY b.usage_date
    `).bind(...heatmapWhere.params).all<{
      usage_date: string;
      total_tokens: number;
      estimated_cost_usd: number;
    }>(),
    loadFacetOptions('device_id', filters, env),
    loadFacetOptions('provider', filters, env),
    loadFacetOptions('product', filters, env),
    loadFacetOptions('channel', filters, env),
    loadFacetOptions('model', filters, env),
    loadFacetOptions('project', filters, env),
    loadInteractionMetrics(filters, env),
    previousFilters ? loadComparison(previousFilters, env) : Promise.resolve(null),
  ]);

  const activeDays = Number(summary?.active_days ?? 0);
  const totalEvents = Number(summary?.total_events ?? 0);
  const totalSessions = Number(summary?.total_sessions ?? 0);
  const costBearingEvents = Number(summary?.cost_bearing_events ?? 0);
  const totalCostUsd = roundUsd(summary?.total_cost_usd ?? 0);

  return jsonOk({
    totalDays: filters.rangeDays ?? activeDays,
    activeDays,
    totalEvents,
    totalSessions,
    costBearingEvents,
    totalCostUsd,
    averageDailyCostUsd: activeDays > 0 ? roundUsd(totalCostUsd / activeDays) : 0,
    dailyTrend: (trendRows.results ?? []).map(row => ({
      usageDate: row.usage_date,
      eventCount: Number(row.event_count ?? 0),
      estimatedCostUsd: roundUsd(row.estimated_cost_usd ?? 0),
    })),
    providerDailyTrend: (providerTrendRows.results ?? []).map(row => ({
      usageDate: row.usage_date,
      provider: row.provider,
      estimatedCostUsd: roundUsd(row.estimated_cost_usd ?? 0),
    })),
    tokenComposition: (tokenRows.results ?? []).map(row => ({
      usageDate: row.usage_date,
      inputTokens: Number(row.input_tokens ?? 0),
      cachedInputTokens: Number(row.cached_input_tokens ?? 0),
      cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      reasoningOutputTokens: Number(row.reasoning_output_tokens ?? 0),
      totalTokens:
        Number(row.input_tokens ?? 0) +
        Number(row.cached_input_tokens ?? 0) +
        Number(row.cache_write_tokens ?? 0) +
        Number(row.output_tokens ?? 0) +
        Number(row.reasoning_output_tokens ?? 0),
    })),
    modelCostShare: (modelRows.results ?? []).map(row => ({
      value: row.value,
      label: row.value,
      estimatedCostUsd: roundUsd(row.estimated_cost_usd ?? 0),
      eventCount: Number(row.event_count ?? 0),
    })),
    channelCostShare: (channelRows.results ?? []).map(row => ({
      value: row.value,
      label: row.value,
      estimatedCostUsd: roundUsd(row.estimated_cost_usd ?? 0),
      eventCount: Number(row.event_count ?? 0),
    })),
    sankey: await buildSankey(flowRows.results ?? [], env),
    heatmap: (heatmapRows.results ?? []).map(row => ({
      usageDate: row.usage_date,
      totalTokens: Number(row.total_tokens ?? 0),
      estimatedCostUsd: roundUsd(row.estimated_cost_usd ?? 0),
    })),
    interactionMetrics,
    comparison,
    filters: {
      selection: {
        range: filters.range,
        deviceId: filters.deviceId,
        provider: filters.provider,
        product: filters.product,
        channel: filters.channel,
        model: filters.model,
        project: filters.project,
      },
      options: {
        devices,
        providers,
        products,
        channels,
        models,
        projects,
      },
    },
  }, true, PUBLIC_READ_CACHE_HEADERS);
}

export function parseFilters(url: URL): DashboardFilters | null {
  const range = readTextParam(url, 'range') ?? '30d';
  const window = buildDateWindow(range);
  if (!window) return null;

  return {
    minDate: window.minDate,
    maxDate: window.maxDate,
    rangeDays: window.days,
    range,
    deviceId: readTextParams(url, 'deviceId'),
    provider: readTextParams(url, 'provider'),
    product: readTextParams(url, 'product'),
    channel: readTextParams(url, 'channel'),
    model: readTextParams(url, 'model'),
    project: readTextParams(url, 'project'),
  };
}

function readTextParams(url: URL, key: string): string[] {
  const values = url.searchParams
    .getAll(key)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function readTextParam(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function addValueFilter(
  clauses: string[],
  params: (string | number)[],
  expression: string,
  values: string[],
) {
  if (values.length === 0) return;
  if (values.length === 1) {
    clauses.push(`${expression} = ?`);
    params.push(values[0]);
    return;
  }
  clauses.push(`${expression} IN (${values.map(() => '?').join(', ')})`);
  params.push(...values);
}

export function buildWhere(filters: DashboardFilters, omit?: FilterKey): WhereParts {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filters.minDate) {
    clauses.push('b.usage_date >= ?');
    params.push(filters.minDate);
  }
  if (filters.maxDate) {
    clauses.push('b.usage_date <= ?');
    params.push(filters.maxDate);
  }
  if (omit !== 'deviceId') addValueFilter(clauses, params, 'b.device_id', filters.deviceId);
  if (omit !== 'provider') addValueFilter(clauses, params, 'b.provider', filters.provider);
  if (omit !== 'product') addProductFilter(clauses, params, 'b', filters.product);
  if (omit !== 'channel') addValueFilter(clauses, params, 'b.channel', filters.channel);
  if (omit !== 'model') addValueFilter(clauses, params, 'b.model', filters.model);
  if (omit !== 'project') addValueFilter(clauses, params, PROJECT_DISPLAY_SQL, filters.project);

  return {
    whereClause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

async function loadFacetOptions(column: string, filters: DashboardFilters, env: Env): Promise<FacetItem[]> {
  const omit = toFilterKey(column);
  const where = buildWhere(filters, omit);
  const columnExpr = column === 'project' ? PROJECT_DISPLAY_SQL : `b.${column}`;
  const rows = await env.DB.prepare(`
    SELECT
      ${columnExpr} AS value,
      COALESCE(SUM(b.estimated_cost_usd), 0) AS estimated_cost_usd,
      COALESCE(SUM(b.event_count), 0) AS event_count
    FROM daily_usage_breakdown b
    ${where.whereClause}
    GROUP BY ${columnExpr}
    HAVING value IS NOT NULL AND value != ''
    ORDER BY estimated_cost_usd DESC, value ASC
    LIMIT 80
  `).bind(...where.params).all<{
    value: string;
    estimated_cost_usd: number;
    event_count: number;
  }>();

  const deviceLabels = column === 'device_id' ? await loadDeviceLabels(
    (rows.results ?? []).map(r => r.value),
    env,
  ) : null;

  const items = await Promise.all((rows.results ?? []).map(async row => ({
    value: row.value,
    label: column === 'project'
      ? await toPublicProjectName(row.value, env)
      : column === 'device_id'
        ? (deviceLabels?.get(row.value) ?? row.value)
        : column === 'product'
          ? productLabel(row.value, false)
          : row.value,
    estimatedCostUsd: roundUsd(row.estimated_cost_usd ?? 0),
    eventCount: Number(row.event_count ?? 0),
  })));
  return column === 'product' ? addCombinedTraeFacet(items) : items;
}

async function loadDeviceLabels(deviceIds: string[], env: Env): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!deviceIds.length) return map;
  await Promise.all(deviceIds.map(async id => {
    const row = await env.DB.prepare(
      'SELECT public_label, hostname FROM devices WHERE device_id = ?'
    ).bind(id).first<{ public_label: string | null; hostname: string | null }>();
    if (row) {
      map.set(id, row.public_label || row.hostname || id);
    }
  }));
  return map;
}

function toFilterKey(column: string): FilterKey {
  if (column === 'device_id') return 'deviceId';
  return column as FilterKey;
}

async function loadInteractionMetrics(filters: DashboardFilters, env: Env) {
  const where = buildActivityWhere(filters);
  let rows;
  try {
    rows = await Promise.all([
    env.DB.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN a.kind NOT IN ${USER_MESSAGE_KINDS} AND a.confidence = 'exact' THEN a.event_count ELSE 0 END), 0) AS exact_count,
        COALESCE(SUM(CASE WHEN a.kind NOT IN ${USER_MESSAGE_KINDS} AND a.confidence = 'proxy' THEN a.event_count ELSE 0 END), 0) AS proxy_count,
        COALESCE(SUM(CASE WHEN a.kind = 'user_message' THEN a.event_count ELSE 0 END), 0) AS user_message_count,
        COALESCE(SUM(CASE WHEN a.kind = 'user_message_chars' THEN a.event_count ELSE 0 END), 0) AS user_message_chars,
        COALESCE(SUM(CASE WHEN a.kind = 'function_call' THEN a.event_count ELSE 0 END), 0) AS function_call_count,
        COALESCE(SUM(CASE WHEN a.kind IN ('tool_call', 'custom_tool_call', 'mcp_tool_call') THEN a.event_count ELSE 0 END), 0) AS tool_call_count,
        COALESCE(SUM(CASE WHEN a.kind = 'skill_call' THEN a.event_count ELSE 0 END), 0) AS skill_call_count,
        COALESCE(SUM(CASE WHEN a.kind = 'skill_proxy' THEN a.event_count ELSE 0 END), 0) AS skill_proxy_count,
        COALESCE(SUM(CASE WHEN a.kind = 'agent_call' THEN a.event_count ELSE 0 END), 0) AS subagent_count
      FROM daily_activity_breakdown a
      ${where.whereClause}
    `).bind(...where.params).first<{
      exact_count: number;
      proxy_count: number;
      user_message_count: number;
      user_message_chars: number;
      function_call_count: number;
      tool_call_count: number;
      skill_call_count: number;
      skill_proxy_count: number;
      subagent_count: number;
    }>(),
    loadActivityTopList(where, env, `
      a.kind IN ('function_call', 'custom_tool_call', 'tool_call', 'web_search', 'tool_search', 'image_generation', 'mcp_tool_call')
    `, `a.source || '|' || a.name`, `a.name || ' (' || a.source || ')'`),
    loadActivityTopList(where, env, `
      a.kind IN ('skill_call', 'skill_proxy')
    `, `a.source || '|' || a.name || '|' || a.confidence`, `a.name || ' (' || CASE WHEN a.confidence = 'proxy' THEN 'proxy' ELSE a.source END || ')'`),
    loadActivityTopList(where, env, `
      a.kind = 'agent_call'
    `, `a.source || '|' || a.name`, `a.name || ' (' || a.source || ')'`),
    loadActivityTopList(where, env, `
      a.kind != 'user_message_chars'
    `, `a.kind`, `a.kind`),
    loadPromptTrend(where, env),
    ]);
  } catch (error) {
    if (String(error).includes('daily_activity_breakdown')) return emptyInteractionMetrics();
    throw error;
  }

  const [summary, topTools, topSkills, topAgents, kindShare, promptTrend] = rows;

  const exactCount = Number(summary?.exact_count ?? 0);
  const proxyCount = Number(summary?.proxy_count ?? 0);
  const userMessageCount = Number(summary?.user_message_count ?? 0);

  return {
    exactCount,
    proxyCount,
    userMessageCount,
    userMessageChars: Number(summary?.user_message_chars ?? 0),
    promptTrend,
    functionCallCount: Number(summary?.function_call_count ?? 0),
    toolCallCount: Number(summary?.tool_call_count ?? 0),
    skillCallCount: Number(summary?.skill_call_count ?? 0),
    skillProxyCount: Number(summary?.skill_proxy_count ?? 0),
    subagentCount: Number(summary?.subagent_count ?? 0),
    topTools,
    topSkills,
    topAgents,
    kindShare,
  };
}

async function loadComparison(filters: DashboardFilters, env: Env): Promise<OverviewComparisonPayload> {
  const where = buildWhere(filters);
  const activityWhere = buildActivityWhere(filters);

  const [summary, activity] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(DISTINCT b.usage_date) AS active_days,
        COALESCE(SUM(b.event_count), 0) AS total_events,
        COALESCE(SUM(b.session_count), 0) AS total_sessions,
        COALESCE(SUM(b.estimated_cost_usd), 0) AS total_cost_usd,
        COALESCE(SUM(b.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(b.cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(b.cache_write_tokens), 0) AS cache_write_tokens,
        COALESCE(SUM(b.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(b.reasoning_output_tokens), 0) AS reasoning_output_tokens
      FROM daily_usage_breakdown b
      ${where.whereClause}
    `).bind(...where.params).first<{
      active_days: number;
      total_events: number;
      total_sessions: number;
      total_cost_usd: number;
      input_tokens: number;
      cached_input_tokens: number;
      cache_write_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
    }>(),
    env.DB.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN a.kind = 'user_message' THEN a.event_count ELSE 0 END), 0) AS user_message_count
      FROM daily_activity_breakdown a
      ${activityWhere.whereClause}
    `).bind(...activityWhere.params).first<{ user_message_count: number }>().catch((error) => {
      if (String(error).includes('daily_activity_breakdown')) return null;
      throw error;
    }),
  ]);

  const activeDays = Number(summary?.active_days ?? 0);
  const inputTokens = Number(summary?.input_tokens ?? 0);
  const cachedInputTokens = Number(summary?.cached_input_tokens ?? 0);
  const cacheWriteTokens = Number(summary?.cache_write_tokens ?? 0);
  const outputTokens = Number(summary?.output_tokens ?? 0);
  const reasoningOutputTokens = Number(summary?.reasoning_output_tokens ?? 0);
  const totalTokens = inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens + reasoningOutputTokens;
  const cacheDenominator = inputTokens + cachedInputTokens;
  const totalCostUsd = roundUsd(summary?.total_cost_usd ?? 0);

  return {
    activeDays,
    totalEvents: Number(summary?.total_events ?? 0),
    totalSessions: Number(summary?.total_sessions ?? 0),
    totalCostUsd,
    averageDailyCostUsd: activeDays > 0 ? roundUsd(totalCostUsd / activeDays) : 0,
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    cacheHitRate: cacheDenominator > 0 ? (cachedInputTokens / cacheDenominator) * 100 : 0,
    userMessageCount: activity ? Number(activity.user_message_count ?? 0) : undefined,
  };
}

function emptyInteractionMetrics() {
  return {
    exactCount: 0,
    proxyCount: 0,
    userMessageCount: 0,
    userMessageChars: 0,
    promptTrend: [],
    functionCallCount: 0,
    toolCallCount: 0,
    skillCallCount: 0,
    skillProxyCount: 0,
    subagentCount: 0,
    topTools: [],
    topSkills: [],
    topAgents: [],
    kindShare: [],
  };
}

// Daily human prompt volume: message count and typed characters
async function loadPromptTrend(where: WhereParts, env: Env) {
  const condition = `a.kind IN ${USER_MESSAGE_KINDS}`;
  const rows = await env.DB.prepare(`
    SELECT
      a.usage_date AS usage_date,
      COALESCE(SUM(CASE WHEN a.kind = 'user_message' THEN a.event_count ELSE 0 END), 0) AS message_count,
      COALESCE(SUM(CASE WHEN a.kind = 'user_message_chars' THEN a.event_count ELSE 0 END), 0) AS char_count
    FROM daily_activity_breakdown a
    ${where.whereClause ? `${where.whereClause} AND ${condition}` : `WHERE ${condition}`}
    GROUP BY a.usage_date
    ORDER BY a.usage_date ASC
  `).bind(...where.params).all<{ usage_date: string; message_count: number; char_count: number }>();

  return (rows.results ?? []).map(row => ({
    usageDate: row.usage_date,
    messageCount: Number(row.message_count ?? 0),
    charCount: Number(row.char_count ?? 0),
  }));
}

async function loadActivityTopList(
  where: WhereParts,
  env: Env,
  extraCondition: string,
  keyExpr: string,
  labelExpr: string,
) {
  const combinedWhere = where.whereClause
    ? `${where.whereClause} AND ${extraCondition}`
    : `WHERE ${extraCondition}`;
  const rows = await env.DB.prepare(`
    SELECT
      ${keyExpr} AS value,
      ${labelExpr} AS label,
      COALESCE(SUM(a.event_count), 0) AS event_count,
      COALESCE(SUM(CASE WHEN a.confidence = 'proxy' THEN a.event_count ELSE 0 END), 0) AS proxy_count
    FROM daily_activity_breakdown a
    ${combinedWhere}
    GROUP BY value, label
    ORDER BY event_count DESC, label ASC
    LIMIT 12
  `).bind(...where.params).all<{
    value: string;
    label: string;
    event_count: number;
    proxy_count: number;
  }>();

  return (rows.results ?? []).map(row => ({
    value: row.value,
    label: row.label,
    eventCount: Number(row.event_count ?? 0),
    proxyCount: Number(row.proxy_count ?? 0),
  }));
}

function buildActivityWhere(filters: DashboardFilters): WhereParts {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (filters.minDate) {
    clauses.push('a.usage_date >= ?');
    params.push(filters.minDate);
  }
  if (filters.maxDate) {
    clauses.push('a.usage_date <= ?');
    params.push(filters.maxDate);
  }
  addValueFilter(clauses, params, 'a.device_id', filters.deviceId);
  addValueFilter(clauses, params, 'a.provider', filters.provider);
  addProductFilter(clauses, params, 'a', filters.product);
  if (filters.channel.length > 0 && !filters.channel.includes('cli')) {
    clauses.push('1 = 0');
  }
  if (filters.model.length > 0) {
    clauses.push('1 = 0');
  }
  addValueFilter(clauses, params, ACTIVITY_PROJECT_DISPLAY_SQL, filters.project);

  return {
    whereClause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}

async function buildSankey(rows: Array<{
  model: string;
  project: string;
  total_tokens: number;
}>, env: Env): Promise<{
  nodes: Array<{ id: string; label: string; layer: number; totalTokens: number }>;
  links: Array<{ source: string; target: string; value: number }>;
}> {
  const modelTotals = new Map<string, number>();
  const projectTotals = new Map<string, number>();
  const flowLinks = new Map<string, number>();

  for (const row of rows) {
    const value = Number(row.total_tokens ?? 0);
    if (!value) continue;

    modelTotals.set(row.model, (modelTotals.get(row.model) ?? 0) + value);
    projectTotals.set(row.project, (projectTotals.get(row.project) ?? 0) + value);

    const key = `${row.model}\u0000${row.project}`;
    flowLinks.set(key, (flowLinks.get(key) ?? 0) + value);
  }

  const projectLabels = new Map<string, string>();
  for (const [name] of projectTotals) {
    projectLabels.set(name, await toPublicProjectName(name, env));
  }

  const nodes = [
    ...sortedNodeEntries(modelTotals).map(([label, totalTokens]) => ({
      id: `model-${label}`,
      label,
      layer: 0,
      totalTokens,
    })),
    ...sortedNodeEntries(projectTotals).map(([name, totalTokens]) => ({
      id: `project-${name}`,
      label: projectLabels.get(name) ?? name,
      layer: 1,
      totalTokens,
    })),
  ];

  const links = sortedLinkEntries(flowLinks).map(([key, value]) => {
    const [model, project] = key.split('\u0000');
    return {
      source: `model-${model}`,
      target: `project-${project}`,
      value,
    };
  });

  return { nodes, links };
}

function sortedNodeEntries(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0], 'zh-CN');
  });
}

function sortedLinkEntries(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function roundUsd(value: number): number {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

export function buildDateWindow(
  range: string,
  now: Date = new Date(),
): { minDate: string | null; maxDate: string | null; days: number | null } | undefined {
  if (range === 'all') return { minDate: null, maxDate: null, days: null };

  const today = startOfUtcDay(now);
  let start: Date;
  let days: number;

  if (range === '7d') days = 7;
  else if (range === '30d') days = 30;
  else if (range === '3m' || range === '90d') days = 90;
  else if (range === 'month') {
    start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    days = diffUtcDays(start, today) + 1;
    return { minDate: formatDate(start), maxDate: formatDate(today), days };
  } else return undefined;

  start = addUtcDays(today, -(days - 1));
  return { minDate: formatDate(start), maxDate: formatDate(today), days };
}

function buildPreviousFilters(filters: DashboardFilters): DashboardFilters | null {
  if (!filters.minDate || !filters.rangeDays) return null;
  const currentStart = parseDateOnly(filters.minDate);
  const previousMax = addUtcDays(currentStart, -1);
  const previousMin = addUtcDays(currentStart, -filters.rangeDays);
  return {
    ...filters,
    minDate: formatDate(previousMin),
    maxDate: formatDate(previousMax),
  };
}

function todayDateString(): string {
  return formatDate(startOfUtcDay(new Date()));
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function diffUtcDays(start: Date, end: Date): number {
  return Math.round((startOfUtcDay(end).getTime() - startOfUtcDay(start).getTime()) / 86400000);
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function addProductFilter(
  clauses: string[],
  params: (string | number)[],
  tableAlias: 'a' | 'b',
  products: string[],
): void {
  if (products.length === 0) return;
  const expanded = new Set<string>();
  for (const product of products) {
    if (product === 'trae') {
      expanded.add('trae');
      expanded.add('trae-cn');
      expanded.add('trae-intl');
    } else {
      expanded.add(product);
    }
  }
  const values = [...expanded];
  if (values.length === 1) {
    clauses.push(`${tableAlias}.product = ?`);
    params.push(values[0]);
    return;
  }
  clauses.push(`${tableAlias}.product IN (${values.map(() => '?').join(', ')})`);
  params.push(...values);
}

function productLabel(value: string, combined: boolean): string {
  if (value === 'trae-cn') return 'Trae CN';
  if (value === 'trae-intl') return 'Trae International';
  if (value === 'trae') return combined ? 'Trae (All)' : 'Trae (Legacy)';
  return value;
}

function addCombinedTraeFacet(items: FacetItem[]): FacetItem[] {
  const traeItems = items.filter(item => item.value === 'trae' || item.value === 'trae-cn' || item.value === 'trae-intl');
  if (traeItems.length <= 1) return items;

  const combined: FacetItem = {
    value: 'trae',
    label: productLabel('trae', true),
    estimatedCostUsd: roundUsd(traeItems.reduce((sum, item) => sum + item.estimatedCostUsd, 0)),
    eventCount: traeItems.reduce((sum, item) => sum + item.eventCount, 0),
  };
  return [
    ...items.filter(item => item.value !== 'trae' && item.value !== 'trae-cn' && item.value !== 'trae-intl'),
    combined,
    ...traeItems.filter(item => item.value !== 'trae'),
  ].sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || a.label.localeCompare(b.label));
}
