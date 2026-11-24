import type { ModelPricing, ProductPricing } from '../types.js';

/**
 * xAI Grok。
 * 单价 USD / 1M tokens。来源：https://docs.x.ai/developers/pricing
 * 最近核对：2026-09-24
 *
 * Grok 经 OpenCode（providerID=xai）或 Copilot 等工具调用，scanner 以 provider='xai'
 * 上报；OpenCode 自带 cost 时优先采用，否则按此表估算。
 * xAI 无单独缓存写入溢价，cache write 按普通输入价计。
 * US 区域端点另加 10%，本地日志无法区分，统一按全球价计。
 */
const models: Record<string, ModelPricing> = {
  'grok-4.7': {
    currency: 'USD',
    notes: 'prompts of 200K+ input tokens bill the full request at long-context rates; -fast is 2x',
    input_per_million: 2,
    cached_input_per_million: 0.5,
    cache_write_per_million: 2,
    output_per_million: 6,
    tiers: [
      {
        threshold: 199_999,
        input_per_million: 2,
        cached_input_per_million: 0.5,
        cache_write_per_million: 2,
        output_per_million: 6,
      },
      {
        input_per_million: 4,
        cached_input_per_million: 1,
        cache_write_per_million: 4,
        output_per_million: 12,
      },
    ],
  },
};

export const xai: Record<string, ProductPricing> = {
  opencode: { models },
  'copilot-cli': { models },
  'claude-code': { models },
  'grok-cli': { models },
};
