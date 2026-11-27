import type { PricingCatalog } from './types.js';
import { anthropic } from './data/anthropic.js';
import { openai } from './data/openai.js';
import { google } from './data/google.js';
import { moonshot } from './data/moonshot.js';
import { alibaba } from './data/alibaba.js';
import { deepseek } from './data/deepseek.js';
import { zhipu } from './data/zhipu.js';
import { github } from './data/github.js';
import { sourcegraph } from './data/sourcegraph.js';
import { xai } from './data/xai.js';
import { inflection, cursor, droid, opencode } from './data/placeholders.js';

export const PRICING_VERSION = '2026-11-27-v1';

/**
 * 模型别名（精确匹配优先于前缀回退）。
 * key = 出现在数据里的 raw model 名，value = 标准 model 名。
 */
const aliases: Record<string, string> = {
  'claude-fibre-5': 'claude-fable-5',
  'claude-fiber-5': 'claude-fable-5',
  'claude-fable-5.1': 'claude-fable-5-1',
  'claude-fable-5.2': 'claude-fable-5-2',
  'claude-ops-5': 'claude-opus-5',
  'claude-opus-5.5': 'claude-opus-5-5',
  'claude-sonnet-5.5': 'claude-sonnet-5-5',
  'claude-opus-4-7-20260201': 'claude-opus-4-7',
  'claude-sonnet-4-6-20250301': 'claude-sonnet-4-6',
  'claude-opus-4-6-20250301': 'claude-opus-4-6',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  'claude-sonnet-4.6': 'claude-sonnet-4-6',
  'deepseek-flash': 'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-1017': 'deepseek-v4.1-flash',
  'gpt-5.6': 'gpt-5.6-sol',
  'codex-auto-review': 'gpt-5.4',
  'grok-4-7': 'grok-4.7',
  'k3': 'kimi-k3',
  'kimi-code/k3': 'kimi-k3',
  'kimi-k3.1': 'kimi-k3.1-pro',
};

export const catalog: PricingCatalog = {
  version: PRICING_VERSION,
  // 汇率（1 USD ≈ N CNY）。Worker 启动时可被 env 覆盖。
  fx: {
    CNY: 7.2,
  },
  aliases,
  providers: {
    anthropic: { ...anthropic, antigravity: { models: Object.fromEntries(
      ['claude-opus-5-5', 'claude-sonnet-5-5'].map(model => [model, anthropic['claude-code'].models[model]]),
    ) } },
    openai,
    google: { ...google, antigravity: { models: Object.fromEntries(
      ['gemini-4-neon', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']
        .map(model => [model, google['gemini-cli'].models[model]]),
    ) } },
    moonshot,
    alibaba,
    deepseek,
    zhipu,
    github,
    sourcegraph,
    xai,
    inflection,
    cursor,
    droid,
    opencode,
  },
};

export function getPricingCatalog(): PricingCatalog {
  return catalog;
}
