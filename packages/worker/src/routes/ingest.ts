import type { IngestActivityItem, IngestPayload, CostStatus } from '@aiusage/shared';
import { jsonOk, jsonError } from '../utils/response.js';
import { verifyDeviceToken } from '../utils/token.js';
import { calculateIngestBreakdownCost, getWorstCostStatus } from '../utils/pricing.js';
import type { Env } from '../types.js';

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  // 校验 DEVICE_TOKEN
  const auth = request.headers.get('Authorization')?.replace('Bearer ', '');
  if (!auth) return jsonError(401, 'INVALID_TOKEN', 'Missing authorization');

  const tokenPayload = await verifyDeviceToken(auth, env.DEVICE_TOKEN_SECRET);
  if (!tokenPayload) return jsonError(401, 'INVALID_TOKEN', 'Invalid device token');

  const body = await request.json<IngestPayload>();

  // 校验一致性
  if (body.siteId !== tokenPayload.siteId) {
    return jsonError(403, 'SITE_ID_MISMATCH', 'Site ID mismatch');
  }
  if (body.device.deviceId !== tokenPayload.deviceId) {
    return jsonError(403, 'DEVICE_ID_MISMATCH', 'Device ID mismatch');
  }

  // 校验设备状态与 token_version
  const device = await env.DB.prepare('SELECT status, token_version FROM devices WHERE device_id = ?')
    .bind(tokenPayload.deviceId)
    .first<{ status: string; token_version: number }>();

  if (!device) return jsonError(401, 'INVALID_TOKEN', 'Device not found');
  if (device.status !== 'active') return jsonError(403, 'DEVICE_DISABLED', 'Device has been disabled');
  if (device.token_version !== tokenPayload.tokenVersion) {
    return jsonError(401, 'TOKEN_VERSION_MISMATCH', 'Token version mismatch');
  }

  const now = new Date().toISOString();
  const costSummary: Record<string, { estimatedCostUsd: number; costStatus: CostStatus }> = {};

  for (const day of body.days) {
    const costStatuses: CostStatus[] = [];
    const breakdownsWithCost = [];
    let dayTotalCost = 0;
    let dayTotalEvents = 0;
    let dayTotalInput = 0;
    let dayTotalCachedInput = 0;
    let dayTotalCacheWrite = 0;
    let dayTotalOutput = 0;
    let dayTotalReasoning = 0;

    // 按 breakdown 写入
    for (const b of day.breakdowns) {
      const cacheWrite5mTokens = b.cacheWrite5mTokens ?? b.cacheWriteTokens;
      const cacheWrite1hTokens = b.cacheWrite1hTokens ?? 0;
      const cost = calculateIngestBreakdownCost(b);

      costStatuses.push(cost.costStatus);
      dayTotalCost += cost.estimatedCostUsd;
      dayTotalEvents += b.eventCount;
      dayTotalInput += b.inputTokens;
      dayTotalCachedInput += b.cachedInputTokens;
      dayTotalCacheWrite += b.cacheWriteTokens;
      dayTotalOutput += b.outputTokens;
      dayTotalReasoning += b.reasoningOutputTokens;
      breakdownsWithCost.push({ breakdown: b, cost, cacheWrite5mTokens, cacheWrite1hTokens });
    }

    const dayCostStatus = getWorstCostStatus(costStatuses);

    // 每天的写入合并为一次 D1 batch：逐条 await 会让 30 天的批次触发上千次子请求而被 Worker 拒绝
    // 父记录排在最前，避免 breakdown 外键约束失败
    const statements: D1PreparedStatement[] = [];
    statements.push(env.DB.prepare(`
      INSERT INTO daily_usage
        (device_id, usage_date, event_count, input_tokens, cached_input_tokens,
         cache_write_tokens, output_tokens, reasoning_output_tokens,
         estimated_cost_usd, cost_status, pricing_version,
         top_project_by_cost, top_project_cost_usd, top_model_by_cost, top_model_cost_usd,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (device_id, usage_date)
      DO UPDATE SET
        event_count = excluded.event_count,
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_output_tokens = excluded.reasoning_output_tokens,
        estimated_cost_usd = excluded.estimated_cost_usd,
        cost_status = excluded.cost_status,
        pricing_version = excluded.pricing_version,
        top_project_by_cost = excluded.top_project_by_cost,
        top_project_cost_usd = excluded.top_project_cost_usd,
        top_model_by_cost = excluded.top_model_by_cost,
        top_model_cost_usd = excluded.top_model_cost_usd,
        updated_at = excluded.updated_at
    `)
      .bind(
        tokenPayload.deviceId, day.usageDate,
        dayTotalEvents, dayTotalInput, dayTotalCachedInput, dayTotalCacheWrite,
        dayTotalOutput, dayTotalReasoning,
        Math.round(dayTotalCost * 10000) / 10000, dayCostStatus, 'current',
        'pending', 0,
        'pending', 0,
        now, now,
      ));

    if (day.breakdowns.some(b => b.product === 'trae-cn' || b.product === 'trae-intl')) {
      // CLI 1.7.5 briefly stored both editions as `trae`. Once the same day is
      // re-uploaded with explicit editions, remove only that legacy bucket so
      // it cannot be counted twice. Other tools and partial imports stay intact.
      statements.push(env.DB.prepare(
        "DELETE FROM daily_usage_breakdown WHERE device_id = ? AND usage_date = ? AND product = 'trae'",
      )
        .bind(tokenPayload.deviceId, day.usageDate));
    }

    for (const { breakdown: b, cost, cacheWrite5mTokens, cacheWrite1hTokens } of breakdownsWithCost) {
      const rawProject = b.project || 'unknown';
      const isFullPath = rawProject.startsWith('/') || /^[A-Z]:\\/i.test(rawProject);
      const projectDisplay = b.projectDisplay ?? (isFullPath ? rawProject.split('/').filter(Boolean).pop() || 'unknown' : rawProject);
      const projectAlias = b.projectAlias ?? null;

      statements.push(env.DB.prepare(`
        INSERT INTO daily_usage_breakdown
          (device_id, usage_date, provider, product, channel, model, project,
           project_display, project_alias,
           event_count, session_count, input_tokens, cached_input_tokens, cache_write_tokens,
           output_tokens, reasoning_output_tokens, estimated_cost_usd, cost_status,
           pricing_version, extra_metrics_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (device_id, usage_date, provider, product, channel, model, project)
        DO UPDATE SET
          project_display = excluded.project_display,
          project_alias = excluded.project_alias,
          event_count = excluded.event_count,
          session_count = excluded.session_count,
          input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          estimated_cost_usd = excluded.estimated_cost_usd,
          cost_status = excluded.cost_status,
          pricing_version = excluded.pricing_version,
          extra_metrics_json = excluded.extra_metrics_json,
          updated_at = excluded.updated_at
      `)
        .bind(
          tokenPayload.deviceId, day.usageDate,
          b.provider, b.product, b.channel, b.model || 'unknown', rawProject,
          projectDisplay, projectAlias,
          b.eventCount, b.sessionCount ?? 0, b.inputTokens, b.cachedInputTokens, b.cacheWriteTokens,
          b.outputTokens, b.reasoningOutputTokens,
          cost.estimatedCostUsd, cost.costStatus, cost.pricingVersion,
          JSON.stringify({
            cache_write_5m_tokens: cacheWrite5mTokens,
            cache_write_1h_tokens: cacheWrite1hTokens,
          }),
          now, now,
        ));
    }

    // 回填 top project / model
    statements.push(env.DB.prepare(`
      UPDATE daily_usage
      SET top_project_by_cost = COALESCE((
            SELECT COALESCE(project_alias, project_display) FROM daily_usage_breakdown
            WHERE device_id = ?1 AND usage_date = ?2
            GROUP BY COALESCE(project_alias, project_display) ORDER BY SUM(estimated_cost_usd) DESC LIMIT 1
          ), 'unknown'),
          top_project_cost_usd = COALESCE((
            SELECT SUM(estimated_cost_usd) AS total_cost FROM daily_usage_breakdown
            WHERE device_id = ?1 AND usage_date = ?2
            GROUP BY COALESCE(project_alias, project_display) ORDER BY total_cost DESC LIMIT 1
          ), 0),
          top_model_by_cost = COALESCE((
            SELECT model FROM daily_usage_breakdown
            WHERE device_id = ?1 AND usage_date = ?2
            GROUP BY model ORDER BY SUM(estimated_cost_usd) DESC LIMIT 1
          ), 'unknown'),
          top_model_cost_usd = COALESCE((
            SELECT SUM(estimated_cost_usd) AS total_cost FROM daily_usage_breakdown
            WHERE device_id = ?1 AND usage_date = ?2
            GROUP BY model ORDER BY total_cost DESC LIMIT 1
          ), 0),
          updated_at = ?3
      WHERE device_id = ?1 AND usage_date = ?2
    `).bind(tokenPayload.deviceId, day.usageDate, now));

    await env.DB.batch(statements);
    await replaceActivityMetrics(env, tokenPayload.deviceId, day.usageDate, day.activity?.items ?? [], now);

    costSummary[day.usageDate] = {
      estimatedCostUsd: Math.round(dayTotalCost * 10000) / 10000,
      costStatus: dayCostStatus,
    };
  }

  // 更新 last_seen_at + 别名（sync 时自动同步本地别名）
  await env.DB.prepare(
    'UPDATE devices SET last_seen_at = ?, app_version = ?, public_label = COALESCE(?, public_label) WHERE device_id = ?',
  )
    .bind(now, body.device.appVersion, body.device.deviceAlias ?? null, tokenPayload.deviceId)
    .run();

  return jsonOk({ daysProcessed: body.days.length, costSummary });
}

async function replaceActivityMetrics(
  env: Env,
  deviceId: string,
  usageDate: string,
  items: IngestActivityItem[],
  now: string,
): Promise<void> {
  try {
    const statements = [
      env.DB.prepare('DELETE FROM daily_activity_breakdown WHERE device_id = ? AND usage_date = ?')
        .bind(deviceId, usageDate),
    ];

    for (const item of items) {
      const count = Math.max(0, Math.floor(Number(item.count ?? 0)));
      if (count === 0) continue;
      const rawProject = item.project || 'unknown';
      const isFullPath = rawProject.startsWith('/') || /^[A-Z]:\\/i.test(rawProject);
      const projectDisplay = item.projectDisplay ?? (isFullPath ? rawProject.split('/').filter(Boolean).pop() || 'unknown' : rawProject);

      statements.push(env.DB.prepare(`
        INSERT INTO daily_activity_breakdown
          (device_id, usage_date, provider, product, source, project,
           project_display, project_alias, kind, name, confidence, event_count,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
        .bind(
          deviceId,
          usageDate,
          item.provider || 'unknown',
          item.product || 'unknown',
          item.source || `${item.provider || 'unknown'}/${item.product || 'unknown'}`,
          rawProject,
          projectDisplay,
          item.projectAlias ?? null,
          item.kind || 'unknown',
          item.name || 'unknown',
          item.confidence === 'proxy' ? 'proxy' : 'exact',
          count,
          now,
          now,
        ));
    }
    await env.DB.batch(statements);
  } catch (error) {
    if (String(error).includes('daily_activity_breakdown')) return;
    throw error;
  }
}
