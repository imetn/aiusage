import { describe, it, expect } from 'vitest';
import { calculateCost, catalog } from '../pricing/index.js';

// ─── 结构完整性 ───

describe('catalog 结构', () => {
  it('catalog.version 与 fx 已配置', () => {
    expect(catalog.version).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(catalog.fx.CNY).toBeGreaterThan(0);
  });

  it('每个 scanner 涉及的 (provider, product) 都存在于 catalog', () => {
    const required: Array<[string, string]> = [
      ['anthropic', 'claude-code'],
      ['openai', 'codex'],
      ['google', 'gemini-cli'],
      ['google', 'antigravity'],
      ['github', 'copilot-cli'],
      ['github', 'copilot-vscode'],
      ['moonshot', 'kimi-code'],
      ['alibaba', 'qwen-code'],
      ['sourcegraph', 'amp'],
      ['inflection', 'pi'],
      ['cursor', 'cursor'],
      ['droid', 'droid'],
      ['opencode', 'opencode'],
      ['xai', 'opencode'],
      ['xai', 'copilot-cli'],
    ];
    const missing = required.filter(([p, pr]) => !catalog.providers[p]?.[pr]);
    expect(missing).toEqual([]);
  });
});

// ─── 关键模型定价能解析 ───

describe('calculateCost — 关键模型', () => {
  const tokens = {
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1_000_000,
  };

  it.each([
    ['anthropic', 'claude-code', 'claude-fable-5-1', 60], // 10 + 50
    ['anthropic', 'claude-code', 'claude-fable-5', 60], // 10 + 50
    ['anthropic', 'claude-code', 'claude-mythos-5', 60], // 10 + 50
    ['anthropic', 'claude-code', 'claude-opus-5-5', 24], // 4 + 20
    ['anthropic', 'claude-code', 'claude-opus-5.5', 24], // alias → claude-opus-5-5
    ['anthropic', 'claude-code', 'claude-opus-5', 30], // 5 + 25
    ['anthropic', 'claude-code', 'claude-opus-4-8', 30], // 5 + 25
    ['anthropic', 'claude-code', 'claude-opus-4-7', 30], // 5 + 25
    ['anthropic', 'claude-code', 'claude-sonnet-5', 12], // 2 + 10（intro through 2026-08-31）
    ['anthropic', 'claude-code', 'claude-sonnet-4-6', 18],
    ['openai', 'codex', 'gpt-6-astra', 95], // 长上下文：20 + 75
    ['openai', 'codex', 'gpt-6-sol', 19], // 长上下文：4 + 15
    ['openai', 'codex', 'gpt-6-luna', 0.95], // 长上下文：0.2 + 0.75
    ['xai', 'opencode', 'grok-4.7', 16], // 长上下文：4 + 12
    ['openai', 'codex', 'gpt-5.6-sol', 38], // 长上下文：8 + 30
    ['openai', 'codex', 'gpt-5.6-terra', 22], // 长上下文：4 + 18
    ['openai', 'codex', 'gpt-5.6-luna', 2.2], // 长上下文：0.4 + 1.8
    ['openai', 'codex', 'gpt-5.4', 27.5], // 长上下文：5 + 22.5
    ['openai', 'codex', 'gpt-5.5-pro', 330], // 长上下文：60 + 270
    ['openai', 'codex', 'o3-deep-research', 25], // 5 + 20，修正后
    ['openai', 'codex', 'computer-use-preview', 7.5], // 1.5 + 6，修正后
    ['google', 'gemini-cli', 'gemini-2.5-flash', 2.8], // 0.30 + 2.50，修正后
    ['moonshot', 'kimi-code', 'k3', 120 / 7.2], // alias → kimi-k3，¥20 + ¥100
  ])('%s/%s/%s 应等于 $%s', (provider, product, model, expected) => {
    const r = calculateCost(provider, product, model, tokens);
    expect(r.costStatus).toBe('exact');
    expect(r.estimatedCostUsd).toBeCloseTo(expected, 4);
  });

  it.each([
    ['openai', 'codex', 'gpt-6-sol', 1.145], // 0.05M×2 + 0.1M×0.2 + 0.01M×2.5 + 0.1M×10
    ['openai', 'codex', 'gpt-6-luna', 0.05725], // 0.05M×0.1 + 0.1M×0.01 + 0.01M×0.125 + 0.1M×0.5
    ['xai', 'copilot-cli', 'grok-4.7', 0.77], // 0.05M×2 + 0.1M×0.5 + 0.01M×2（写缓存按输入价）+ 0.1M×6
  ])('%s/%s/%s 短上下文含缓存为 $%s', (provider, product, model, expected) => {
    const r = calculateCost(provider, product, model, {
      inputTokens: 50_000, cachedInputTokens: 100_000, cacheWriteTokens: 10_000, outputTokens: 100_000,
    });
    expect(r.matchedTierIndex).toBe(0);
    expect(r.estimatedCostUsd).toBeCloseTo(expected, 3);
  });

  it('Opus 5.5 缓存读写按专属费率计费', () => {
    const r = calculateCost('anthropic', 'claude-code', 'claude-opus-5-5', {
      inputTokens: 0,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(r.estimatedCostUsd).toBeCloseTo(0.2 + 5 + 8, 4);
  });

  it.each([
    ['anthropic', 'claude-code', 'claude-opus-5-5-fast', 48],
    ['openai', 'codex', 'gpt-6-sol-fast', 24],
    ['openai', 'codex', 'gpt-6-luna-priority', 1.2],
    ['xai', 'opencode', 'grok-4.7-fast', 16],
  ])('%s/%s/%s fast/priority 按 2x 计为 $%s', (provider, product, model, expected) => {
    const r = calculateCost(provider, product, model, {
      inputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000,
    }, { requestCount: 10 });
    expect(r.estimatedCostUsd).toBeCloseTo(expected, 4);
  });

  it('未知模型返回 unavailable', () => {
    const r = calculateCost('anthropic', 'claude-code', 'totally-unknown', tokens);
    expect(r.costStatus).toBe('unavailable');
    expect(r.estimatedCostUsd).toBe(0);
  });

  it('版本后缀别名（alias）解析为 exact', () => {
    const r = calculateCost('anthropic', 'claude-code', 'claude-opus-4-7-20260201', tokens);
    expect(r.resolvedModel).toBe('claude-opus-4-7');
    expect(r.costStatus).toBe('exact');
  });

  it('常见误写别名解析为 exact', () => {
    const fable = calculateCost('anthropic', 'claude-code', 'claude-fibre-5', tokens);
    const opus = calculateCost('anthropic', 'claude-code', 'claude-ops-5', tokens);
    expect(fable.resolvedModel).toBe('claude-fable-5');
    expect(fable.costStatus).toBe('exact');
    expect(opus.resolvedModel).toBe('claude-opus-5');
    expect(opus.costStatus).toBe('exact');
  });

  it('语义化未知后缀触发前缀回退（estimated）', () => {
    const r = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-6-bedrock', tokens);
    expect(r.resolvedModel).toBe('claude-sonnet-4-6');
    expect(r.costStatus).toBe('estimated');
  });

  it('纯日期后缀视为独立版本，未登记则 unavailable（不再静默回退）', () => {
    const r = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-6-20260101', tokens);
    expect(r.costStatus).toBe('unavailable');
  });
});

// ─── 跨档防护（fallback 不应跨版本号档位）───

describe('跨档防护', () => {
  const tokens = {
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1_000_000,
  };

  it('已知 claude-opus-4-7 不应回退到 claude-opus-4（即便都在表中）', () => {
    const r = calculateCost('anthropic', 'claude-code', 'claude-opus-4-7', tokens);
    expect(r.resolvedModel).toBe('claude-opus-4-7');
    expect(r.costStatus).toBe('exact');
  });

  it('已登记的 claude-opus-4-8 命中 exact 而非吞到 claude-opus-4', () => {
    const r = calculateCost('anthropic', 'claude-code', 'claude-opus-4-8', tokens);
    expect(r.resolvedModel).toBe('claude-opus-4-8');
    expect(r.costStatus).toBe('exact');
  });

  it('未来未登记的 claude-opus-4-9 应返回 unavailable 而非吞到 claude-opus-4', () => {
    const r = calculateCost('anthropic', 'claude-code', 'claude-opus-4-9', tokens);
    expect(r.costStatus).toBe('unavailable');
    expect(r.estimatedCostUsd).toBe(0);
  });

  it('claude-sonnet-4-9 同理拒绝跨档', () => {
    const r = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-9', tokens);
    expect(r.costStatus).toBe('unavailable');
  });

  it('带语义后缀（非纯数字）的版本可以回退', () => {
    const r = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-6-bedrock', tokens);
    expect(r.resolvedModel).toBe('claude-sonnet-4-6');
    expect(r.costStatus).toBe('estimated');
  });
});

// ─── Fast 模式白名单 ───

describe('Fast 模式白名单', () => {
  const tokens = {
    inputTokens: 1_000_000,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1_000_000,
  };

  it('Opus 5-fast 应 ×2', () => {
    const fast = calculateCost('anthropic', 'claude-code', 'claude-opus-5-fast', tokens);
    const normal = calculateCost('anthropic', 'claude-code', 'claude-opus-5', tokens);
    expect(fast.estimatedCostUsd).toBeCloseTo(normal.estimatedCostUsd * 2, 3);
  });

  it('Opus 4.8-fast 应 ×2', () => {
    const fast = calculateCost('anthropic', 'claude-code', 'claude-opus-4-8-fast', tokens);
    const normal = calculateCost('anthropic', 'claude-code', 'claude-opus-4-8', tokens);
    expect(fast.estimatedCostUsd).toBeCloseTo(normal.estimatedCostUsd * 2, 3);
  });

  it('Opus 4.7-fast 应 ×6', () => {
    const fast = calculateCost('anthropic', 'claude-code', 'claude-opus-4-7-fast', tokens);
    const normal = calculateCost('anthropic', 'claude-code', 'claude-opus-4-7', tokens);
    expect(fast.estimatedCostUsd).toBeCloseTo(normal.estimatedCostUsd * 6, 3);
  });

  it('Opus 4.6-fast 现按标准价', () => {
    const fast = calculateCost('anthropic', 'claude-code', 'claude-opus-4-6-fast', tokens);
    const normal = calculateCost('anthropic', 'claude-code', 'claude-opus-4-6', tokens);
    expect(fast.estimatedCostUsd).toBe(normal.estimatedCostUsd);
  });

  it('Sonnet-fast 不应 ×6（官方不支持）', () => {
    const fast = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-6-fast', tokens);
    const normal = calculateCost('anthropic', 'claude-code', 'claude-sonnet-4-6', tokens);
    expect(fast.estimatedCostUsd).toBe(normal.estimatedCostUsd);
  });

  it('Haiku-fast 不应 ×6', () => {
    const fast = calculateCost('anthropic', 'claude-code', 'claude-haiku-4-5-fast', tokens);
    const normal = calculateCost('anthropic', 'claude-code', 'claude-haiku-4-5', tokens);
    expect(fast.estimatedCostUsd).toBe(normal.estimatedCostUsd);
  });

  it('Gemini-fast 不应 ×6', () => {
    const fast = calculateCost('google', 'gemini-cli', 'gemini-2.5-flash-fast', tokens);
    const normal = calculateCost('google', 'gemini-cli', 'gemini-2.5-flash', tokens);
    expect(fast.estimatedCostUsd).toBe(normal.estimatedCostUsd);
  });

  it('Codex GPT-5.5 priority 应 ×2.5', () => {
    const priority = calculateCost('openai', 'codex', 'gpt-5.5-priority', tokens);
    const normal = calculateCost('openai', 'codex', 'gpt-5.5', tokens);
    expect(priority.estimatedCostUsd).toBeCloseTo(normal.estimatedCostUsd * 2.5, 3);
  });

  it('Codex GPT-5.6 Terra priority 应 ×2', () => {
    const priority = calculateCost('openai', 'codex', 'gpt-5.6-terra-priority', tokens);
    const normal = calculateCost('openai', 'codex', 'gpt-5.6-terra', tokens);
    expect(priority.estimatedCostUsd).toBeCloseTo(normal.estimatedCostUsd * 2, 3);
  });

  it('Codex GPT-6 Astra fast 应 ×2', () => {
    const fast = calculateCost('openai', 'codex', 'gpt-6-astra-fast', tokens);
    const normal = calculateCost('openai', 'codex', 'gpt-6-astra', tokens);
    expect(fast.estimatedCostUsd).toBeCloseTo(normal.estimatedCostUsd * 2, 3);
  });

  it('Codex GPT-5.6 Fast 尚未获官方支持时不放大', () => {
    const fast = calculateCost('openai', 'codex', 'gpt-5.6-sol-fast', tokens);
    const normal = calculateCost('openai', 'codex', 'gpt-5.6-sol', tokens);
    expect(fast.estimatedCostUsd).toBe(normal.estimatedCostUsd);
  });

  it('Codex GPT-5.4 fast 应 ×2', () => {
    const fast = calculateCost('openai', 'codex', 'gpt-5.4-fast', tokens);
    const normal = calculateCost('openai', 'codex', 'gpt-5.4', tokens);
    expect(fast.estimatedCostUsd).toBeCloseTo(normal.estimatedCostUsd * 2, 3);
  });

  it('Codex GPT-5-Codex fast 暂无官方倍率时不放大', () => {
    const fast = calculateCost('openai', 'codex', 'gpt-5-codex-fast', tokens);
    const normal = calculateCost('openai', 'codex', 'gpt-5-codex', tokens);
    expect(fast.estimatedCostUsd).toBe(normal.estimatedCostUsd);
  });
});

// ─── 多币种折算 ───

describe('多币种折算', () => {
  it('Kimi K2.6 CNY 价应被折算成 USD（按 fx.CNY=7.2）', () => {
    const r = calculateCost('moonshot', 'kimi-code', 'kimi-k2.6', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    // input ¥6.5 + output ¥27 = ¥33.5 → $4.6528
    expect(r.estimatedCostUsd).toBeCloseTo(33.5 / 7.2, 3);
    expect(r.costStatus).toBe('exact');
  });

  it('Kimi Code 的 k3 别名应命中 Kimi K3，并区分缓存命中价格', () => {
    const r = calculateCost('moonshot', 'kimi-code', 'k3', {
      inputTokens: 1_000_000,
      cachedInputTokens: 2_000_000,
      cacheWriteTokens: 500_000,
      outputTokens: 100_000,
    });
    // input ¥20 + cached ¥4 + cache miss/write ¥10 + output ¥10 = ¥44 → $6.1111
    expect(r.resolvedModel).toBe('kimi-k3');
    expect(r.estimatedCostUsd).toBeCloseTo(44 / 7.2, 4);
    expect(r.costStatus).toBe('exact');
  });

  it('DeepSeek v4-flash 已是 USD，不折算', () => {
    const r = calculateCost('deepseek', 'deepseek-chat', 'deepseek-v4-flash', {
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000_000,
    });
    // 0.14 + 0.28 = 0.42
    expect(r.estimatedCostUsd).toBeCloseTo(0.42, 4);
  });
});

// ─── 阶梯定价 ───

describe('阶梯定价', () => {
  it('GPT-5.6 Sol 的 gpt-5.6 别名命中短上下文价格', () => {
    const r = calculateCost('openai', 'codex', 'gpt-5.6', {
      inputTokens: 100_000,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 50_000,
      cacheWrite5mTokens: 50_000,
      cacheWrite1hTokens: 0,
      outputTokens: 20_000,
    });
    // 0.1*$4 + 0.1*$0.4 + 0.05*$5 + 0.02*$20 = $1.09
    expect(r.resolvedModel).toBe('gpt-5.6-sol');
    expect(r.matchedTierIndex).toBe(0);
    expect(r.costStatus).toBe('exact');
    expect(r.estimatedCostUsd).toBeCloseTo(1.09, 4);
  });

  it('GPT-6 Astra 精确区分缓存读写并命中短上下文价格', () => {
    const r = calculateCost('openai', 'codex', 'gpt-6-astra', {
      inputTokens: 10_000,
      cachedInputTokens: 60_000,
      cacheWriteTokens: 30_000,
      outputTokens: 10_000,
    });
    expect(r.matchedTierIndex).toBe(0);
    expect(r.estimatedCostUsd).toBeCloseTo(1.035, 4);
  });

  it('GPT-6 Astra 超过 272K input 后整次请求命中长上下文价格', () => {
    const r = calculateCost('openai', 'codex', 'gpt-6-astra', {
      inputTokens: 300_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100_000,
    });
    expect(r.matchedTierIndex).toBe(1);
    expect(r.estimatedCostUsd).toBeCloseTo(13.5, 4);
  });

  it('Claude Fable 5.1 缓存读写使用独立价格', () => {
    const r = calculateCost('anthropic', 'claude-code', 'claude-fable-5-1', {
      inputTokens: 100_000,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 100_000,
      cacheWrite5mTokens: 60_000,
      cacheWrite1hTokens: 40_000,
      outputTokens: 10_000,
    });
    expect(r.estimatedCostUsd).toBeCloseTo(3.075, 4);
  });

  it('GPT-5.6 Sol 超过 272K input 后整次请求命中长上下文价格', () => {
    const r = calculateCost('openai', 'codex', 'gpt-5.6-sol', {
      inputTokens: 300_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100_000,
    });
    expect(r.matchedTierIndex).toBe(1);
    expect(r.estimatedCostUsd).toBeCloseTo(5.4, 4); // 0.3*$8 + 0.1*$30
  });

  it('GPT-5.6 Sol 的聚合用量按平均单请求 input 选择阶梯', () => {
    const r = calculateCost('openai', 'codex', 'gpt-5.6-sol', {
      inputTokens: 400_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20_000,
    }, { requestCount: 2 });
    expect(r.matchedTierIndex).toBe(0);
    expect(r.costStatus).toBe('estimated');
    expect(r.estimatedCostUsd).toBeCloseTo(2, 4); // 两个 200K + 10K output 的短请求
  });

  it('GPT-5.5 的短请求继续使用短上下文价格', () => {
    const r = calculateCost('openai', 'codex', 'gpt-5.5', {
      inputTokens: 100_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10_000,
    });
    expect(r.matchedTierIndex).toBe(0);
    expect(r.estimatedCostUsd).toBeCloseTo(0.8, 4);
  });

  it('GPT-5.4 超过 272K input 后使用长上下文价格', () => {
    const r = calculateCost('openai', 'codex', 'gpt-5.4', {
      inputTokens: 300_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100_000,
    });
    expect(r.matchedTierIndex).toBe(1);
    expect(r.estimatedCostUsd).toBeCloseTo(3.75, 4);
  });

  it('Qwen3-coder-plus ≤32K 命中第 0 档', () => {
    const r = calculateCost('alibaba', 'qwen-code', 'qwen3-coder-plus', {
      inputTokens: 10_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5_000,
    });
    expect(r.matchedTierIndex).toBe(0);
    // (10000/1e6)*4 + (5000/1e6)*16 = 0.04 + 0.08 = 0.12 ¥ → /7.2 ≈ 0.0167
    expect(r.estimatedCostUsd).toBeCloseTo(0.12 / 7.2, 3);
  });

  it('Qwen3-coder-plus >128K 命中第 2 档', () => {
    const r = calculateCost('alibaba', 'qwen-code', 'qwen3-coder-plus', {
      inputTokens: 200_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1000,
    });
    expect(r.matchedTierIndex).toBe(2);
  });

  it('Gemini 2.5 Pro ≤200K 命中低价档', () => {
    const r = calculateCost('google', 'gemini-cli', 'gemini-2.5-pro', {
      inputTokens: 100_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 50_000,
    });
    expect(r.matchedTierIndex).toBe(0);
    // 100K*$1.25/M + 50K*$10/M = 0.125 + 0.5 = $0.625
    expect(r.estimatedCostUsd).toBeCloseTo(0.625, 4);
  });

  it('Gemini 2.5 Pro >200K 命中高价档', () => {
    const r = calculateCost('google', 'gemini-cli', 'gemini-2.5-pro', {
      inputTokens: 500_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_000,
    });
    expect(r.matchedTierIndex).toBe(1);
  });
});

// Sources verified 2026-10-20: OpenAI GPT-6.1 Sol model card and Anthropic pricing.
describe('October 2026 pricing gaps', () => {
  it('GPT-6.1 Sol includes its 5% cache-read and cache-write rates', () => {
    const r = calculateCost('openai', 'codex', 'gpt-6.1-sol', {
      inputTokens: 50_000, cachedInputTokens: 100_000, cacheWriteTokens: 10_000, outputTokens: 100_000,
    });
    expect(r.costStatus).toBe('exact');
    expect(r.estimatedCostUsd).toBeCloseTo(1.135, 4);
    expect(r.matchedTierIndex).toBe(0);
  });
  it('GPT-6.1 Sol charges the full request above 272K input tokens', () => {
    const r = calculateCost('openai', 'codex', 'gpt-6.1-sol', {
      inputTokens: 200_000, cachedInputTokens: 100_000, cacheWriteTokens: 10_000, outputTokens: 100_000,
    });
    expect(r.estimatedCostUsd).toBeCloseTo(2.37, 4);
    expect(r.matchedTierIndex).toBe(1);
  });
  it.each([['fast', 2], ['priority', 2], ['ultrafast', 6]])('GPT-6.1 Sol %s has an explicit multiplier', (tier, multiplier) => {
    const r = calculateCost('openai', 'codex', `gpt-6.1-sol-${tier}`, {
      inputTokens: 100_000, cachedInputTokens: 100_000, cacheWriteTokens: 0, outputTokens: 100_000,
    });
    expect(r.estimatedCostUsd).toBeCloseTo(1.21 * Number(multiplier), 4);
  });
  it('Sonnet 5.5 distinguishes cache reads and both cache-write lifetimes', () => {
    const r = calculateCost('anthropic', 'claude-code', 'claude-sonnet-5-5', {
      inputTokens: 1_000_000, cachedInputTokens: 1_000_000,
      cacheWriteTokens: 2_000_000, cacheWrite5mTokens: 1_000_000, cacheWrite1hTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(r.costStatus).toBe('exact');
    expect(r.estimatedCostUsd).toBeCloseTo(18.6, 4);
  });
});

describe('GPT-6.2 pricing', () => {
  it.each([
    ['gpt-6.2-astra', 2.144, 4.088],
    ['gpt-6.2-sol', 0.536, 1.022],
  ])('prices %s across the 272K threshold including cache tokens', (model, shortCost, longCost) => {
    const tokens = { inputTokens: 200_000, cachedInputTokens: 60_000, cacheWriteTokens: 12_000, outputTokens: 10_000 };
    expect(calculateCost('openai', 'codex', model, tokens)).toMatchObject({
      costStatus: 'exact', estimatedCostUsd: shortCost, matchedTierIndex: 0,
    });
    expect(calculateCost('openai', 'codex', model, { ...tokens, inputTokens: 200_001 })).toMatchObject({
      costStatus: 'exact', estimatedCostUsd: longCost, matchedTierIndex: 1,
    });
  });

  it.each([['fast', 2.4], ['priority', 2.4], ['batch', 0.6]])('prices Astra with the explicit %s suffix', (tier, cost) => {
    expect(calculateCost('openai', 'codex', `gpt-6.2-astra-${tier}`, {
      inputTokens: 100_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10_000,
    })).toMatchObject({ costStatus: 'exact', estimatedCostUsd: cost, resolvedModel: 'gpt-6.2-astra' });
  });

  it.each([['gpt-6.2-astra', 3.6, 7.2], ['gpt-6.2-sol', 0.9, 1.8]])(
    'switches %s Ultrafast at midnight Pacific', (model, promotionCost, listCost) => {
      const tokens = { inputTokens: 100_000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10_000 };
      const price = (usageTime: number | string) => calculateCost('openai', 'codex', `${model}-ultrafast`, tokens, { usageTime });
      expect(price(Date.parse('2027-03-01T07:59:59.999Z'))).toMatchObject({ costStatus: 'exact', estimatedCostUsd: promotionCost });
      expect(price(Date.parse('2027-03-01T08:00:00.000Z'))).toMatchObject({ costStatus: 'exact', estimatedCostUsd: listCost });
      expect(price('2027-02-28')).toMatchObject({ costStatus: 'estimated', estimatedCostUsd: promotionCost });
      expect(price('2027-03-01')).toMatchObject({ costStatus: 'estimated', estimatedCostUsd: listCost });
    },
  );
});

describe('November 2026 pricing gaps', () => {
  it.each([
    [250_000, 'gpt-6.1-terra', 0.7631, 0],
    [250_100, 'gpt-6.1-terra', 1.2764, 1],
    [250_100, 'gpt-6.1-terra-fast', 2.5528, 1],
  ])('prices Terra at %i uncached input tokens with model ID %s', (inputTokens, model, expectedCost, tier) => {
    expect(calculateCost('openai', 'codex', model, {
      inputTokens, cachedInputTokens: 12_000, cacheWriteTokens: 10_000, outputTokens: 100_000,
    })).toMatchObject({ costStatus: 'exact', estimatedCostUsd: expectedCost, matchedTierIndex: tier });
  });

  it.each([
    ['claude-fable-5-2', 7.42],
    ['claude-fable-5-2-fast', 14.84],
  ])('prices %s with separate 5-minute and 1-hour cache writes', (model, expectedCost) => {
    expect(calculateCost('anthropic', 'claude-code', model, {
      inputTokens: 100_000, cachedInputTokens: 100_000, cacheWriteTokens: 200_000,
      cacheWrite5mTokens: 100_000, cacheWrite1hTokens: 100_000, outputTokens: 100_000,
    })).toMatchObject({ costStatus: 'exact', estimatedCostUsd: expectedCost });
  });

  it.each([
    [70_000, 0.0186, 0],
    [71_000, 0.0935, 1],
  ])('prices Haiku with %i uncached tokens using total prompt length', (inputTokens, expectedCost, tier) => {
    expect(calculateCost('anthropic', 'claude-code', 'claude-haiku-5-5', {
      inputTokens, cachedInputTokens: 10_000, cacheWriteTokens: 20_000,
      cacheWrite5mTokens: 10_000, cacheWrite1hTokens: 10_000, outputTokens: 16_500,
    })).toMatchObject({ costStatus: 'exact', estimatedCostUsd: expectedCost, matchedTierIndex: tier });
  });

  it('uses the Flash-Lite rate instead of the Gemini 3.5 Flash rate', () => {
    expect(calculateCost('google', 'gemini-cli', 'gemini-3.5-flash-lite', {
      inputTokens: 1_000_000, cachedInputTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000,
    })).toMatchObject({ costStatus: 'exact', estimatedCostUsd: 2.83, resolvedModel: 'gemini-3.5-flash-lite' });
  });
});
