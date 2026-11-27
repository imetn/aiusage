import type { ProductPricing } from '../types.js';

/**
 * 智谱 GLM。
 * 单价 CNY / 1M tokens。来源：https://bigmodel.cn/pricing
 * 最近核对：2026-11-27
 *
 * GLM-5.1 / GLM-4.7 按 input 长度分档；GLM-4.7 还按 output 长度二次分档，
 * 这里我们只按 input 阶梯（保守取 output<200K 档），与其他 provider 一致。
 */
export const zhipu: Record<string, ProductPricing> = {
  'glm-chat': {
    models: {
      // https://bigmodel.cn/pricing (2026-11-27)
      'glm-5.3': {
        currency: 'CNY',
        notes: '1M context; flat rate',
        input_per_million: 8,
        cached_input_per_million: 2,
        output_per_million: 28,
      },
      'glm-5.3-flashx': {
        currency: 'CNY',
        notes: '1M context',
        input_per_million: 2,
        cached_input_per_million: 0.57,
        output_per_million: 7,
      },
      'glm-5.3-flash': {
        currency: 'CNY',
        notes: '1M context',
        input_per_million: 0.8,
        cached_input_per_million: 0.23,
        output_per_million: 2.8,
      },
      'glm-5.2': {
        currency: 'CNY',
        notes: '1M context; flat rate',
        input_per_million: 8,
        cached_input_per_million: 2,
        output_per_million: 28,
      },
      'glm-5.1': {
        currency: 'CNY',
        tiers: [
          { threshold: 32_000, input_per_million: 6, output_per_million: 24, cached_input_per_million: 1.3 },
          { input_per_million: 8, output_per_million: 28, cached_input_per_million: 2 },
        ],
      },
      'glm-5-turbo': {
        currency: 'CNY',
        tiers: [
          { threshold: 32_000, input_per_million: 5, output_per_million: 22, cached_input_per_million: 1.2 },
          { input_per_million: 7, output_per_million: 26, cached_input_per_million: 1.8 },
        ],
      },
      'glm-5': {
        currency: 'CNY',
        tiers: [
          { threshold: 32_000, input_per_million: 4, output_per_million: 18, cached_input_per_million: 1 },
          { input_per_million: 6, output_per_million: 22, cached_input_per_million: 1.5 },
        ],
      },
      'glm-4.7': {
        currency: 'CNY',
        notes: 'output<200 archetype; >200 doubles output rate',
        tiers: [
          { threshold: 32_000, input_per_million: 2, output_per_million: 8, cached_input_per_million: 0.4 },
          { threshold: 200_000, input_per_million: 4, output_per_million: 16, cached_input_per_million: 0.8 },
        ],
      },
      'glm-4.5-air': {
        currency: 'CNY',
        tiers: [
          { threshold: 32_000, input_per_million: 0.8, output_per_million: 2, cached_input_per_million: 0.16 },
          { threshold: 128_000, input_per_million: 1.2, output_per_million: 8, cached_input_per_million: 0.24 },
        ],
      },
      'glm-4.7-flashx': {
        currency: 'CNY',
        input_per_million: 0.5,
        cached_input_per_million: 0.1,
        output_per_million: 3,
      },
      'glm-4.7-flash': {
        currency: 'CNY',
        notes: 'free tier',
        input_per_million: 0,
        cached_input_per_million: 0,
        output_per_million: 0,
      },
      'glm-4-plus': {
        currency: 'CNY',
        input_per_million: 5,
        output_per_million: 5,
      },
      'glm-4-air': {
        currency: 'CNY',
        input_per_million: 0.5,
        output_per_million: 0.5,
      },
      'glm-4-airx': {
        currency: 'CNY',
        input_per_million: 10,
        output_per_million: 10,
      },
      'glm-4-flashx-250414': {
        currency: 'CNY',
        input_per_million: 0.1,
        output_per_million: 0.1,
      },
      'glm-4-long': {
        currency: 'CNY',
        input_per_million: 1,
        output_per_million: 1,
      },
      'glm-4.5': {
        currency: 'CNY',
        notes: 'legacy, 128K context',
        input_per_million: 4,
        output_per_million: 16,
      },
      'glm-4.6': {
        currency: 'CNY',
        notes: 'legacy, 200K context',
        input_per_million: 4,
        output_per_million: 16,
      },
    },
  },
};
