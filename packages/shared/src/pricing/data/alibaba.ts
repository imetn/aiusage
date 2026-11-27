import type { ProductPricing } from '../types.js';

/**
 * 阿里云通义千问 Qwen。
 * 单价 CNY / 1M tokens。来源：https://help.aliyun.com/zh/model-studio/model-pricing
 * 最近核对：2026-11-27
 *
 * 多数 qwen3-* 模型按 input 长度分档（32K / 128K / 256K / 1M）；qwen4-max 全 1M 统一单价。
 */
export const alibaba: Record<string, ProductPricing> = {
  'qwen-code': {
    models: {
      // https://help.aliyun.com/zh/model-studio/model-pricing (2026-11-27)
      'qwen4-max': {
        currency: 'CNY',
        notes: '1M context; flat rate across standard and thinking modes',
        input_per_million: 10,
        output_per_million: 30,
      },
      'qwen3.8-max': {
        currency: 'CNY',
        input_per_million: 12,
        output_per_million: 36,
      },
      'qwen3.7-max': {
        currency: 'CNY',
        input_per_million: 12,
        output_per_million: 36,
      },
      'qwen3.6-plus': {
        currency: 'CNY',
        notes: 'tiered by input length, 256K threshold',
        tiers: [
          { threshold: 256_000, input_per_million: 2, output_per_million: 12 },
          { input_per_million: 8, output_per_million: 48 },
        ],
      },
      'qwen3.5-plus': {
        currency: 'CNY',
        notes: 'tiered by input length',
        tiers: [
          { threshold: 128_000, input_per_million: 0.8, output_per_million: 4.8 },
          { threshold: 256_000, input_per_million: 2, output_per_million: 12 },
          { input_per_million: 4, output_per_million: 24 },
        ],
      },
      'qwen3.5-flash': {
        currency: 'CNY',
        notes: 'tiered by input length',
        tiers: [
          { threshold: 128_000, input_per_million: 0.2, output_per_million: 2 },
          { input_per_million: 0.8, output_per_million: 8 },
        ],
      },
      'qwen3-coder-plus': {
        currency: 'CNY',
        notes: 'tiered by input length',
        tiers: [
          { threshold: 32_000, input_per_million: 4, output_per_million: 16 },
          { threshold: 128_000, input_per_million: 6, output_per_million: 24 },
          { threshold: 256_000, input_per_million: 10, output_per_million: 40 },
          { input_per_million: 20, output_per_million: 200 },
        ],
      },
      'qwen3-coder-flash': {
        currency: 'CNY',
        tiers: [
          { threshold: 32_000, input_per_million: 1, output_per_million: 4 },
          { threshold: 128_000, input_per_million: 1.5, output_per_million: 6 },
          { threshold: 256_000, input_per_million: 2, output_per_million: 8 },
          { input_per_million: 3, output_per_million: 30 },
        ],
      },
      'qwen-coder-plus': {
        currency: 'CNY',
        input_per_million: 3.5,
        output_per_million: 7,
      },
      'qwen3-max': {
        currency: 'CNY',
        tiers: [
          { threshold: 32_000, input_per_million: 2.5, output_per_million: 10 },
          { threshold: 128_000, input_per_million: 5, output_per_million: 20 },
          { threshold: 256_000, input_per_million: 10, output_per_million: 100 },
        ],
      },
      'qwen-max': {
        currency: 'CNY',
        input_per_million: 2.4,
        output_per_million: 9.6,
      },
      'qwen-plus': {
        currency: 'CNY',
        notes: 'cache hit ¥0.8/M',
        cached_input_per_million: 0.8,
        input_per_million: 2,
        output_per_million: 8,
      },
      'qwen-turbo': {
        currency: 'CNY',
        notes: 'cache hit ¥0.3/M',
        cached_input_per_million: 0.3,
        input_per_million: 0.6,
        output_per_million: 3,
      },
      'qwen3-32b': {
        currency: 'CNY',
        input_per_million: 2,
        output_per_million: 8,
      },
      'qwen3-235b-a22b-thinking-2507': {
        currency: 'CNY',
        input_per_million: 2,
        output_per_million: 20,
      },
      'qwen3-235b-a22b-instruct-2507': {
        currency: 'CNY',
        input_per_million: 2,
        output_per_million: 8,
      },
    },
  },
};
