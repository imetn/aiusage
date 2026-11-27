import type { ProductPricing } from '../types.js';

/**
 * Sourcegraph Amp。
 *
 * Amp 按打包月费 / 请求计费，不公开 per-token 单价。
 * 这里同样是按底层 Anthropic / Google 官方单价复制的"影子价"，仅作估算。
 *
 * 最近核对：2026-07-26
 */
export const sourcegraph: Record<string, ProductPricing> = {
  amp: {
    models: {
      'claude-sonnet-5': {
        currency: 'USD',
        notes: 'permanent standard pricing ($2/$10)',
        input_per_million: 2,
        cached_input_per_million: 0.2,
        output_per_million: 10,
      },
      'claude-sonnet-4': { currency: 'USD', input_per_million: 3, cached_input_per_million: 0.3, output_per_million: 15 },
      'claude-sonnet-3.7': { currency: 'USD', input_per_million: 3, cached_input_per_million: 0.3, output_per_million: 15 },
      'gemini-2.5-pro': { currency: 'USD', input_per_million: 1.25, cached_input_per_million: 0.125, output_per_million: 10 },
    },
  },
};
