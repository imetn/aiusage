import type { ProductPricing } from '../types.js';

/**
 * Moonshot Kimi。
 * 单价 CNY / 1M tokens。来源：https://platform.kimi.com/docs/pricing/chat
 * 最近核对：2026-11-27
 *
 * Kimi 区分 cache hit / miss 及 K3 系列 5m / 1h 缓存写入价：
 * - input_per_million = cache miss 价
 * - cached_input_per_million = cache hit 价
 * - wire 中的 inputCacheCreation 归入 cache write 展示，K3 / K3.1 Pro 默认按 5m 写入价计费
 */
export const moonshot: Record<string, ProductPricing> = {
  'kimi-code': {
    models: {
      // https://platform.kimi.com/docs/pricing/chat (2026-11-27)
      'kimi-k3.1-pro': {
        currency: 'CNY',
        input_per_million: 13,
        cached_input_per_million: 1.3,
        cache_write_5m_per_million: 13,
        cache_write_1h_per_million: 26,
        output_per_million: 68,
      },
      'kimi-k3.1-pro-highspeed': {
        currency: 'CNY',
        input_per_million: 26,
        cached_input_per_million: 1.3,
        cache_write_5m_per_million: 26,
        cache_write_1h_per_million: 52,
        output_per_million: 136,
      },
      'kimi-k3': {
        currency: 'CNY',
        effective_from: '2026-07-17',
        input_per_million: 20,
        cached_input_per_million: 2,
        cache_write_5m_per_million: 20,
        cache_write_1h_per_million: 40,
        output_per_million: 100,
      },
      'kimi-k2.7-code': {
        currency: 'CNY',
        input_per_million: 6.5,
        cached_input_per_million: 1.3,
        cache_write_per_million: 6.5,
        output_per_million: 27,
      },
      'kimi-k2.7-code-highspeed': {
        currency: 'CNY',
        input_per_million: 13,
        cached_input_per_million: 2.6,
        cache_write_per_million: 13,
        output_per_million: 54,
      },
      'kimi-k2.6': {
        currency: 'CNY',
        input_per_million: 6.5,
        cached_input_per_million: 1.1,
        cache_write_per_million: 6.5,
        output_per_million: 27,
      },
      'kimi-k2.5': {
        currency: 'CNY',
        input_per_million: 4,
        cached_input_per_million: 0.7,
        cache_write_per_million: 4,
        output_per_million: 21,
      },
      'kimi-k2-0905-preview': {
        currency: 'CNY',
        notes: 'will be retired 2026-05-25',
        input_per_million: 4,
        cached_input_per_million: 1,
        cache_write_per_million: 4,
        output_per_million: 16,
      },
      'kimi-k2-0711-preview': {
        currency: 'CNY',
        notes: 'will be retired 2026-05-25',
        input_per_million: 4,
        cached_input_per_million: 1,
        cache_write_per_million: 4,
        output_per_million: 16,
      },
      'kimi-k2-turbo-preview': {
        currency: 'CNY',
        notes: 'will be retired 2026-05-25',
        input_per_million: 8,
        cached_input_per_million: 1,
        cache_write_per_million: 8,
        output_per_million: 58,
      },
      'kimi-k2-thinking': {
        currency: 'CNY',
        input_per_million: 4,
        cached_input_per_million: 1,
        cache_write_per_million: 4,
        output_per_million: 16,
      },
      'kimi-k2-thinking-turbo': {
        currency: 'CNY',
        input_per_million: 8,
        cached_input_per_million: 1,
        cache_write_per_million: 8,
        output_per_million: 58,
      },
      'moonshot-v1-8k': {
        currency: 'CNY',
        input_per_million: 2,
        cache_write_per_million: 2,
        output_per_million: 10,
      },
      'moonshot-v1-32k': {
        currency: 'CNY',
        input_per_million: 5,
        cache_write_per_million: 5,
        output_per_million: 20,
      },
      'moonshot-v1-128k': {
        currency: 'CNY',
        input_per_million: 10,
        cache_write_per_million: 10,
        output_per_million: 30,
      },
      'moonshot-v1-8k-vision-preview': {
        currency: 'CNY',
        input_per_million: 2,
        cache_write_per_million: 2,
        output_per_million: 10,
      },
      'moonshot-v1-32k-vision-preview': {
        currency: 'CNY',
        input_per_million: 5,
        cache_write_per_million: 5,
        output_per_million: 20,
      },
      'moonshot-v1-128k-vision-preview': {
        currency: 'CNY',
        input_per_million: 10,
        cache_write_per_million: 10,
        output_per_million: 30,
      },
    },
  },
};
