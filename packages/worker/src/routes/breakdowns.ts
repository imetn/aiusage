import { DEFAULT_BREAKDOWN_LIMIT, MAX_BREAKDOWN_LIMIT } from '@aiusage/shared';
import { PUBLIC_READ_CACHE_HEADERS, jsonError, jsonOk } from '../utils/response.js';
import { toPublicProjectName } from '../utils/privacy.js';
import { addModelFilter } from '../utils/model-group.js';
import type { Env } from '../types.js';

const SORT_FIELDS: Record<string, string> = {
  usage_date: 'b.usage_date',
  device_id: 'b.device_id',
  provider: 'b.provider',
  product: 'b.product',
  channel: 'b.channel',
  model: 'b.model',
  project: 'COALESCE(b.project_alias, b.project_display)',
  event_count: 'b.event_count',
  input_tokens: 'b.input_tokens',
  cached_input_tokens: 'b.cached_input_tokens',
  cache_write_tokens: 'b.cache_write_tokens',
  output_tokens: 'b.output_tokens',
  reasoning_output_tokens: 'b.reasoning_output_tokens',
  estimated_cost_usd: 'b.estimated_cost_usd',
  total_tokens: `
    COALESCE(b.input_tokens, 0) +
    COALESCE(b.cached_input_tokens, 0) +
    COALESCE(b.cache_write_tokens, 0) +
    COALESCE(b.output_tokens, 0) +
    COALESCE(b.reasoning_output_tokens, 0)
  `,
};

export async function handleBreakdowns(url: URL, env: Env): Promise<Response> {
  const range = url.searchParams.get('range') ?? '30d';
  const date = readTextParam(url, 'date');
  const deviceId = readTextParam(url, 'deviceId');
  const provider = readTextParam(url, 'provider');
  const product = readTextParam(url, 'product');
  const model = readTextParam(url, 'model');
  const channel = readTextParam(url, 'channel');
  const project = readTextParam(url, 'project');
  const limit = clampLimit(url.searchParams.get('limit'));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const sort = normalizeSort(url.searchParams.get('sort'));
  const order = normalizeOrder(url.searchParams.get('order'));

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (date) {
    conditions.push('b.usage_date = ?');
    params.push(date);
  } else {
    const minDate = buildMinDate(range);
    if (minDate === undefined) return jsonError(400, 'INVALID_PAYLOAD', 'Invalid range parameter', true);
    if (minDate) {
      conditions.push('b.usage_date >= ?');
      params.push(minDate);
    }
  }

  if (deviceId) {
    conditions.push('b.device_id = ?');
    params.push(deviceId);
  }
  if (provider) {
    conditions.push('b.provider = ?');
    params.push(provider);
  }
  if (product) {
    if (product === 'trae') {
      conditions.push('b.product IN (?, ?, ?)');
      params.push('trae', 'trae-cn', 'trae-intl');
    } else {
      conditions.push('b.product = ?');
      params.push(product);
    }
  }
  if (model) {
    addModelFilter(conditions, params, [model]);
  }
  if (channel) {
    conditions.push('b.channel = ?');
    params.push(channel);
  }
  if (project) {
    conditions.push('COALESCE(b.project_alias, b.project_display) = ?');
    params.push(project);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sortExpression = SORT_FIELDS[sort];

  const countResult = await env.DB.prepare(`
    SELECT COUNT(*) AS total
    FROM daily_usage_breakdown b
    ${whereClause}
  `).bind(...params).first<{ total: number }>();

  const rows = await env.DB.prepare(`
    SELECT
      b.device_id,
      b.usage_date,
      b.provider,
      b.product,
      b.channel,
      b.model,
      COALESCE(b.project_alias, b.project_display) AS project,
      b.event_count,
      b.input_tokens,
      b.cached_input_tokens,
      b.cache_write_tokens,
      b.output_tokens,
      b.reasoning_output_tokens,
      (${SORT_FIELDS.total_tokens}) AS total_tokens,
      b.estimated_cost_usd,
      b.cost_status
    FROM daily_usage_breakdown b
    ${whereClause}
    ORDER BY ${sortExpression} ${order}, b.usage_date DESC, b.estimated_cost_usd DESC
    LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all<{
    device_id: string;
    usage_date: string;
    provider: string;
    product: string;
    channel: string;
    model: string;
    project: string;
    event_count: number;
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
    estimated_cost_usd: number;
    cost_status: string;
  }>();

  const data = await Promise.all((rows.results ?? []).map(async row => ({
    ...row,
    estimated_cost_usd: roundUsd(row.estimated_cost_usd),
    total_tokens: Number(row.total_tokens ?? 0),
    project: await toPublicProjectName(String(row.project ?? 'unknown'), env),
  })));

  const total = Number(countResult?.total ?? 0);

  return jsonOk({
    data,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    },
    sort,
    order,
  }, true, PUBLIC_READ_CACHE_HEADERS);
}

function readTextParam(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function clampLimit(value: string | null): number {
  const parsed = parseInt(value ?? String(DEFAULT_BREAKDOWN_LIMIT), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_BREAKDOWN_LIMIT;
  return Math.min(parsed, MAX_BREAKDOWN_LIMIT);
}

function normalizeSort(value: string | null): string {
  if (!value) return 'estimated_cost_usd';
  return SORT_FIELDS[value] ? value : 'estimated_cost_usd';
}

function normalizeOrder(value: string | null): 'ASC' | 'DESC' {
  return value?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
}

function roundUsd(value: number): number {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function buildMinDate(range: string): string | null | undefined {
  if (range === 'all') return null;

  const now = new Date();
  let days: number;
  if (range === '7d') days = 7;
  else if (range === '30d') days = 30;
  else if (range === '3m' || range === '90d') days = 90;
  else if (range === '6m' || range === '180d') days = 180;
  else return undefined;

  const min = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return min.toISOString().split('T')[0];
}
