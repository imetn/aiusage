import type { ProductPricing } from '../types.js';

/**
 * DeepSeek。
 * 单价 USD / 1M tokens（DeepSeek 官方直接美元定价）。
 * 来源：https://api-docs.deepseek.com/quick_start/pricing/
 * 最近核对：2026-11-27
 *
 * DeepSeek 区分峰时（周一至周五 UTC 01:00–04:00 & 06:00–10:00，不含中国法定节假日）
 * 与闲时（其余时段，5 折）。这里登记官方标准/峰时价并在 notes 注明闲时 5 折价。
 */
export const deepseek: Record<string, ProductPricing> = {
  'deepseek-chat': {
    models: {
      // https://api-docs.deepseek.com/quick_start/pricing/ (2026-11-27)
      'deepseek-v4.1-flash': {
        currency: 'USD',
        notes: 'standard/peak price (DeepSeek-V4.1-Flash-1017); off-peak is 50% off ($0.15/$0.003/$0.60)',
        input_per_million: 0.3,
        cached_input_per_million: 0.006,
        output_per_million: 1.2,
      },
      'deepseek-v4-flash': {
        currency: 'USD',
        notes: 'legacy V4 Flash rate; API alias now routes to DeepSeek-V4.1-Flash-1017',
        input_per_million: 0.14,
        cached_input_per_million: 0.0028,
        output_per_million: 0.28,
      },
      'deepseek-v4-pro': {
        currency: 'USD',
        notes: '75% off promo through 2026-05-31; DeepSeek-V4-Pro-0813 standard/peak from 2026-08-13 (off-peak is 50% off: $0.66/$0.022/$1.98)',
        input_per_million: 0.435,
        cached_input_per_million: 0.003625,
        output_per_million: 0.87,
        price_changes: [
          { effective_from: '2026-06-01', input_per_million: 1.74, cached_input_per_million: 0.0145, output_per_million: 3.48 },
          { effective_from: '2026-08-13', input_per_million: 1.32, cached_input_per_million: 0.044, output_per_million: 3.96 },
        ],
      },
      // 兼容别名（chat = v4-flash 非思考，reasoner = v4-flash 思考），按 v4-flash 同价计
      'deepseek-chat': {
        currency: 'USD',
        notes: 'alias for v4-flash non-thinking',
        input_per_million: 0.14,
        cached_input_per_million: 0.0028,
        output_per_million: 0.28,
      },
      'deepseek-reasoner': {
        currency: 'USD',
        notes: 'alias for v4-flash thinking',
        input_per_million: 0.14,
        cached_input_per_million: 0.0028,
        output_per_million: 0.28,
      },
    },
  },
};
