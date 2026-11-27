import type { ProductPricing } from '../types.js';
import { anthropic } from './anthropic.js';
import { openai } from './openai.js';

/**
 * GitHub Copilot CLI / VSCode。
 *
 * GitHub Copilot 按 "premium request" 套餐计费，不公开 per-token 单价。
 * 这里的价格是按底层模型（OpenAI / Anthropic）的官方单价复制的"影子价"，
 * 仅用于 token 用量的成本估算，不等于 GitHub 实际向你扣的费用。
 * 上层应把 costStatus 标为 'estimated'。
 *
 * 最近核对：2026-11-24
 */
const anthropicModels = anthropic['claude-code'].models;
const openaiModels = openai.codex.models;

export const github: Record<string, ProductPricing> = {
  // copilot-vscode 仅事件计数（日志里无 token 数），保留空 models 不算费用
  'copilot-vscode': { models: {} },
  'copilot-cli': {
    models: {
      'gpt-6.2-astra': openaiModels['gpt-6.2-astra'],
      'gpt-6.2-sol': openaiModels['gpt-6.2-sol'],
      'gpt-6.1-terra': openaiModels['gpt-6.1-terra'],
      'gpt-6.1-sol': openaiModels['gpt-6.1-sol'],
      'gpt-6-astra': openaiModels['gpt-6-astra'],
      'gpt-6-sol': openaiModels['gpt-6-sol'],
      'gpt-6-luna': openaiModels['gpt-6-luna'],
      'gpt-4o': { currency: 'USD', input_per_million: 2.5, cached_input_per_million: 1.25, output_per_million: 10 },
      'gpt-4o-mini': { currency: 'USD', input_per_million: 0.15, cached_input_per_million: 0.075, output_per_million: 0.6 },
      'claude-fable-5-2': anthropicModels['claude-fable-5-2'],
      'claude-fable-5-1': anthropicModels['claude-fable-5-1'],
      'claude-fable-5': { currency: 'USD', input_per_million: 10, cached_input_per_million: 1, output_per_million: 50 },
      'claude-mythos-5': { currency: 'USD', input_per_million: 10, cached_input_per_million: 1, output_per_million: 50 },
      'claude-opus-5-5': anthropicModels['claude-opus-5-5'],
      'claude-opus-5': { currency: 'USD', input_per_million: 5, cached_input_per_million: 0.5, output_per_million: 25 },
      'claude-sonnet-5-5': anthropicModels['claude-sonnet-5-5'],
      'claude-haiku-5-5': anthropicModels['claude-haiku-5-5'],
      'claude-sonnet-5': {
        currency: 'USD',
        notes: 'permanent standard pricing ($2/$10)',
        input_per_million: 2,
        cached_input_per_million: 0.2,
        output_per_million: 10,
      },
      'claude-sonnet-4': { currency: 'USD', input_per_million: 3, cached_input_per_million: 0.3, output_per_million: 15 },
      'claude-sonnet-4-6': { currency: 'USD', input_per_million: 3, cached_input_per_million: 0.3, output_per_million: 15 },
      'o3-mini': { currency: 'USD', input_per_million: 1.1, cached_input_per_million: 0.55, output_per_million: 4.4 },
      'gemini-2.0-flash': { currency: 'USD', input_per_million: 0.1, cached_input_per_million: 0.025, output_per_million: 0.4 },
    },
  },
};
