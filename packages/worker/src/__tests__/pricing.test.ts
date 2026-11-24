// NOTE: vitest 尚未添加到 @aiusage/worker devDependencies，运行前需执行：
//   pnpm --filter @aiusage/worker add -D vitest

import { describe, it, expect } from 'vitest';
import {
  calculateCost,
  calculateIngestBreakdownCost,
  getPricingCatalog,
  getWorstCostStatus,
} from '../utils/pricing.js';

// ─── getPricingCatalog ───

describe('getPricingCatalog', () => {
  it('返回包含 version 和 providers 的定价目录', () => {
    const catalog = getPricingCatalog();
    expect(catalog.version).toBeTruthy();
    expect(catalog.providers).toBeDefined();
    expect(catalog.providers.anthropic).toBeDefined();
    expect(catalog.providers.openai).toBeDefined();
  });
});

// ─── calculateCost: 基本计费 ───

describe('calculateCost: 基本计费', () => {
  it.each(['1.7.12', '1.8.3'])('uses the usage date and separate reasoning for Codex GPT-6.2 costs (%s)', (version) => {
    const breakdown = {
      provider: 'openai', product: 'codex', channel: 'cli', model: 'gpt-6.2-sol-ultrafast', project: 'unknown',
      eventCount: 2, inputTokens: 100_000, cachedInputTokens: 0, cacheWriteTokens: 0,
      outputTokens: 50_000, reasoningOutputTokens: 50_000,
    } as const;
    expect(calculateIngestBreakdownCost(breakdown, '2026-11-18', version)).toMatchObject({
      estimatedCostUsd: 3.6, costStatus: 'estimated',
    });
    expect(calculateIngestBreakdownCost(breakdown, '2027-03-02', version)).toMatchObject({
      estimatedCostUsd: 7.2, costStatus: 'estimated',
    });
  });

  it.each(['1.7.11', undefined])('keeps inclusive output on older or unidentified Codex uploads (%s)', (version) => {
    const result = calculateIngestBreakdownCost({
      provider: 'openai', product: 'codex', channel: 'cli', model: 'gpt-6.2-sol', project: 'unknown',
      eventCount: 1, inputTokens: 100_000, cachedInputTokens: 0, cacheWriteTokens: 0,
      outputTokens: 100_000, reasoningOutputTokens: 50_000,
    }, '2026-11-18', version);
    expect(result.estimatedCostUsd).toBe(1.2);
  });
  it('优先采用 scanner 按请求累计的精确成本', () => {
    const result = calculateIngestBreakdownCost({
      provider: 'openai',
      product: 'codex',
      channel: 'cli',
      model: 'gpt-5.6-sol',
      project: '/tmp/project',
      eventCount: 2,
      inputTokens: 500_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20_000,
      reasoningOutputTokens: 0,
      costUSD: 4.1,
      pricingVersion: getPricingCatalog().version,
    });

    expect(result.estimatedCostUsd).toBe(4.1);
    expect(result.costStatus).toBe('exact');
  });

  it('定价版本不一致时拒绝客户端预计算成本', () => {
    const result = calculateIngestBreakdownCost({
      provider: 'openai',
      product: 'codex',
      channel: 'cli',
      model: 'gpt-5.6-sol',
      project: '/tmp/project',
      eventCount: 2,
      inputTokens: 500_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20_000,
      reasoningOutputTokens: 0,
      costUSD: 4.1,
      pricingVersion: 'stale-catalog',
    });

    expect(result.estimatedCostUsd).toBe(2.4);
    expect(result.costStatus).toBe('estimated');
  });

  it('始终采用 Trae 国际版官方 API 返回的账号费用', () => {
    const result = calculateIngestBreakdownCost({
      provider: 'openai',
      product: 'trae-intl',
      channel: 'ide',
      model: 'gpt-5.4',
      project: 'unknown',
      eventCount: 1,
      inputTokens: 100,
      cachedInputTokens: 200,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningOutputTokens: 0,
      costUSD: 0.25,
      pricingVersion: 'stale-catalog',
    });

    expect(result.estimatedCostUsd).toBe(0.25);
    expect(result.costStatus).toBe('exact');
  });

  it('始终采用 OpenCode 消息中持久化的供应商费用', () => {
    const result = calculateIngestBreakdownCost({
      provider: 'openai',
      product: 'opencode',
      channel: 'cli',
      model: 'gpt-5.6',
      project: '/tmp/project',
      eventCount: 2,
      inputTokens: 500,
      cachedInputTokens: 100,
      cacheWriteTokens: 0,
      outputTokens: 50,
      reasoningOutputTokens: 0,
      costUSD: 0.42,
      pricingVersion: 'opencode-provider',
    });

    expect(result.estimatedCostUsd).toBe(0.42);
    expect(result.costStatus).toBe('exact');
  });

  it('始终采用 Grok CLI 供应商上报的精确费用，缺省时按含推理输出折算', () => {
    const reported = calculateIngestBreakdownCost({
      provider: 'xai',
      product: 'grok-cli',
      channel: 'cli',
      model: 'grok-4.7-build',
      project: '/tmp/project',
      eventCount: 2,
      inputTokens: 40_000,
      cachedInputTokens: 60_000,
      cacheWriteTokens: 0,
      outputTokens: 6_000,
      reasoningOutputTokens: 4_000,
      costUSD: 1.2345,
      pricingVersion: 'grok-provider',
    });
    expect(reported.estimatedCostUsd).toBe(1.2345);
    expect(reported.costStatus).toBe('exact');

    const fallback = calculateIngestBreakdownCost({
      provider: 'xai',
      product: 'grok-cli',
      channel: 'cli',
      model: 'grok-4.7',
      project: '/tmp/project',
      eventCount: 1,
      inputTokens: 100_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 60_000,
      reasoningOutputTokens: 40_000,
    });
    expect(fallback.estimatedCostUsd).toBeCloseTo(0.8, 4); // 0.1M*$2 + 0.1M*$6
  });

  it('忽略旧 scanner 用作缺省值的零成本', () => {
    const result = calculateIngestBreakdownCost({
      provider: 'openai',
      product: 'codex',
      channel: 'cli',
      model: 'gpt-5.6-sol',
      project: '/tmp/project',
      eventCount: 2,
      inputTokens: 400_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20_000,
      reasoningOutputTokens: 0,
      costUSD: 0,
    });

    expect(result.estimatedCostUsd).toBe(2);
    expect(result.costStatus).toBe('estimated');
  });

  it('Claude haiku-4-5 基本 input/output 计费', () => {
    // haiku-4-5: input=$1/M, output=$5/M
    const result = calculateCost('anthropic', 'claude-code', 'claude-haiku-4-5', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    // 1*1 + 5*1 = $6
    expect(result.estimatedCostUsd).toBe(6);
    expect(result.costStatus).toBe('exact');
    expect(result.pricingVersion).toBeTruthy();
  });

  it('Claude opus-4-6 基本 input/output 计费', () => {
    // opus-4-6: input=$5/M, output=$25/M
    const result = calculateCost('anthropic', 'claude-code', 'claude-opus-4-6', {
      inputTokens: 500_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 200_000,
    });
    // 0.5*5 + 0.2*25 = 2.5 + 5 = $7.5
    expect(result.estimatedCostUsd).toBe(7.5);
    expect(result.costStatus).toBe('exact');
  });

  it('Codex gpt-5.4 基本 input/output 计费', () => {
    // gpt-5.4 long context: input=$5/M, output=$22.5/M
    const result = calculateCost('openai', 'codex', 'gpt-5.4', {
      inputTokens: 2_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 500_000,
    });
    // 2*5 + 0.5*22.5 = $21.25
    expect(result.estimatedCostUsd).toBe(21.25);
    expect(result.costStatus).toBe('exact');
  });

  it('Codex gpt-5.5 基本 input/output 计费', () => {
    // gpt-5.5 long context: input=$10/M, cached input=$1/M, output=$45/M
    const result = calculateCost('openai', 'codex', 'gpt-5.5', {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 0,
      outputTokens: 500_000,
    });
    // 1*10 + 1*1 + 0.5*45 = $33.5
    expect(result.estimatedCostUsd).toBe(33.5);
    expect(result.costStatus).toBe('exact');
  });

  it('Codex auto-review 按 gpt-5.4 估算', () => {
    const result = calculateCost('openai', 'codex', 'codex-auto-review', {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    // gpt-5.4 long context: 1*5 + 1*0.5 + 1*22.5 = $28
    expect(result.estimatedCostUsd).toBe(28);
    // codex-auto-review 是 catalog 里的显式 alias → gpt-5.4，按 exact 处理
    expect(result.costStatus).toBe('exact');
  });

  it('Kimi Code k3 按 Kimi K3 官方价格估算', () => {
    const result = calculateIngestBreakdownCost({
      provider: 'moonshot',
      product: 'kimi-code',
      channel: 'cli',
      model: 'k3',
      project: '/tmp/project',
      eventCount: 1,
      inputTokens: 1_000_000,
      cachedInputTokens: 2_000_000,
      cacheWriteTokens: 500_000,
      outputTokens: 100_000,
      reasoningOutputTokens: 0,
    });

    expect(result.resolvedModel).toBe('kimi-k3');
    expect(result.estimatedCostUsd).toBeCloseTo(44 / 7.2, 4);
    expect(result.costStatus).toBe('exact');
  });
});

// ─── calculateCost: cached input ───

describe('calculateCost: cached input', () => {
  it('包含 cached input 的计费使用缓存价格', () => {
    // haiku-4-5: input=$1/M, cached=$0.1/M, output=$5/M
    const result = calculateCost('anthropic', 'claude-code', 'claude-haiku-4-5', {
      inputTokens: 200_000,
      cachedInputTokens: 800_000,
      cacheWriteTokens: 0,
      outputTokens: 100_000,
    });
    // 0.2*1 + 0.8*0.1 + 0.1*5 = 0.2 + 0.08 + 0.5 = $0.78
    expect(result.estimatedCostUsd).toBe(0.78);
    expect(result.costStatus).toBe('exact');
  });
});

// ─── calculateCost: cache_write_5m / cache_write_1h ───

describe('calculateCost: cache write tokens', () => {
  it('包含 cache_write_5m 和 cache_write_1h 的计费', () => {
    // sonnet-4-6: cache_write_5m=$3.75/M, cache_write_1h=$6/M
    // cacheWriteTokens 必须非零，否则 totalTokens=0 会短路返回
    const result = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-6', {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 1_500_000, // 5m + 1h 总和
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 500_000,
      outputTokens: 0,
    });
    // 1*3.75 + 0.5*6 = 3.75 + 3 = $6.75
    expect(result.estimatedCostUsd).toBe(6.75);
    expect(result.costStatus).toBe('exact');
  });

  it('未提供 cacheWrite5mTokens 时回退到 cacheWriteTokens', () => {
    // sonnet-4-6: cache_write_5m=$3.75/M
    const result = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-6', {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 1_000_000,
      // 不提供 cacheWrite5mTokens
      outputTokens: 0,
    });
    // fallback: cacheWriteTokens 用于 5m 价格 → 1*3.75 = $3.75
    expect(result.estimatedCostUsd).toBe(3.75);
  });
});

// ─── calculateCost: 模型别名解析 ───

describe('calculateCost: 模型别名解析', () => {
  it('claude-haiku-4-5-20251001 解析为 claude-haiku-4-5', () => {
    const aliased = calculateCost('anthropic', 'claude-code', 'claude-haiku-4-5-20251001', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    const direct = calculateCost('anthropic', 'claude-code', 'claude-haiku-4-5', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(aliased.estimatedCostUsd).toBe(direct.estimatedCostUsd);
    // 显式 alias 命中视为 exact（catalog 已声明两名等价）
    expect(aliased.costStatus).toBe('exact');
  });
});

// ─── calculateCost: 模型前缀匹配 ───

describe('calculateCost: 模型前缀匹配', () => {
  it('语义化后缀（如 -bedrock）触发前缀回退 estimated', () => {
    const prefixed = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-6-bedrock', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    const direct = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(prefixed.estimatedCostUsd).toBe(direct.estimatedCostUsd);
    expect(prefixed.costStatus).toBe('estimated');
  });

  it('纯日期后缀不再静默回退（视为独立新版本，未登记则 unavailable）', () => {
    const r = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-6-20260101', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(r.costStatus).toBe('unavailable');
  });
});

// ─── calculateCost: fast 模式（白名单 Opus 4.6/4.7） ───

describe('calculateCost: fast 模式', () => {
  it('Opus 4.7-fast 应 ×6', () => {
    const normal = calculateCost('anthropic', 'claude-code', 'claude-opus-4-7', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    const fast = calculateCost('anthropic', 'claude-code', 'claude-opus-4-7-fast', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(fast.estimatedCostUsd).toBe(
      Math.round(normal.estimatedCostUsd * 6 * 10000) / 10000,
    );
  });

  it('非 Opus 4.6/4.7 的 -fast 后缀不应放大（白名单防护）', () => {
    const normal = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    const fast = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-6-fast', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    expect(fast.estimatedCostUsd).toBe(normal.estimatedCostUsd);
  });
});

// ─── calculateCost: 未知模型 ───

describe('calculateCost: 未知模型', () => {
  it('未知模型返回 cost=0, costStatus=unavailable', () => {
    const result = calculateCost('anthropic', 'claude-code', 'totally-unknown-model', {
      inputTokens: 500_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 500_000,
    });
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.costStatus).toBe('unavailable');
  });

  it('未知 provider 返回 unavailable', () => {
    const result = calculateCost('unknown-provider', 'unknown-product', 'some-model', {
      inputTokens: 100_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100_000,
    });
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.costStatus).toBe('unavailable');
  });
});

// ─── calculateCost: 全零 token ───

describe('calculateCost: 全零 token', () => {
  it('所有 token 为 0 时返回 cost=0, costStatus=exact', () => {
    const result = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-6', {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.costStatus).toBe('exact');
  });
});

// ─── getWorstCostStatus ───

describe('getWorstCostStatus', () => {
  it('全部 exact → exact', () => {
    expect(getWorstCostStatus(['exact', 'exact', 'exact'])).toBe('exact');
  });

  it('包含 estimated → estimated', () => {
    expect(getWorstCostStatus(['exact', 'estimated', 'exact'])).toBe('estimated');
  });

  it('包含 unavailable → unavailable（优先级最高）', () => {
    expect(getWorstCostStatus(['exact', 'estimated', 'unavailable'])).toBe('unavailable');
  });

  it('空数组 → exact', () => {
    expect(getWorstCostStatus([])).toBe('exact');
  });
});

describe('Antigravity disjoint output counters', () => {
  const breakdown = {
    provider: 'google', product: 'antigravity', channel: 'cli', model: 'gemini-4-neon-high', project: 'unknown',
    eventCount: 1, inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0,
    outputTokens: 200_000, reasoningOutputTokens: 800_000,
  } as const;
  it('bills visible and thinking output exactly once', () => {
    expect(calculateIngestBreakdownCost(breakdown, '2026-11-23', '1.8.5')).toMatchObject({
      estimatedCostUsd: 18, costStatus: 'estimated',
    });
  });
  it('keeps client per-request reference prices estimated', () => {
    expect(calculateIngestBreakdownCost({ ...breakdown, costUSD: 17.9999, pricingVersion: getPricingCatalog().version }, '2026-11-23', '1.8.5')).toMatchObject({
      estimatedCostUsd: 17.9999, costStatus: 'estimated',
    });
  });
});
