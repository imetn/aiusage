import type { ProductPricing } from '../types.js';

/**
 * Google Gemini.
 * 单价 USD / 1M tokens。来源：https://ai.google.dev/gemini-api/docs/pricing
 * 最近核对：2026-05-24
 *
 * Gemini 2.5 Pro / 3.1 Pro Preview / 2.5 Computer Use Preview 等按 prompt 长度分档（200K 阈值），用 tiers 表达。
 * 多模态文本/图像/视频/音频价格不同时，统一按 text 价；audio 等专用模型走单独 product（如 TTS、Live API）。
 */
export const google: Record<string, ProductPricing> = {
  // Antigravity 本地不输出 token 信息，仅事件计数；保留空 models 不算费用
  antigravity: { models: {} },

  'gemini-cli': {
    models: {
      // ── Gemini 3.x 系列 ──
      // https://aistudio.google.com/docs/pricing#gemini-3.5-flash-lite (2026-11-14)
      'gemini-3.5-flash-lite': {
        currency: 'USD',
        input_per_million: 0.3,
        output_per_million: 2.5,
        cached_input_per_million: 0.03,
      },
      'gemini-3.5-flash': {
        currency: 'USD',
        input_per_million: 1.5,
        output_per_million: 9,
        cached_input_per_million: 0.15,
      },
      'gemini-3.1-pro-preview': {
        currency: 'USD',
        notes: 'tiered by prompt length, 200K threshold',
        tiers: [
          { threshold: 200_000, input_per_million: 2, cached_input_per_million: 0.2, output_per_million: 12 },
          { input_per_million: 4, cached_input_per_million: 0.4, output_per_million: 18 },
        ],
      },
      'gemini-3.1-flash-lite': {
        currency: 'USD',
        notes: 'text/image/video price; audio is $0.50/M',
        input_per_million: 0.25,
        cached_input_per_million: 0.025,
        output_per_million: 1.5,
      },
      'gemini-3.1-flash-lite-preview': {
        currency: 'USD',
        notes: 'text/image/video price',
        input_per_million: 0.25,
        cached_input_per_million: 0.025,
        output_per_million: 1.5,
      },
      'gemini-3-flash-preview': {
        currency: 'USD',
        notes: 'text/image/video price; audio is $1.00/M',
        input_per_million: 0.5,
        cached_input_per_million: 0.05,
        output_per_million: 3,
      },

      // ── Gemini 2.5 系列 ──
      'gemini-2.5-pro': {
        currency: 'USD',
        notes: 'tiered by prompt length, 200K threshold',
        tiers: [
          { threshold: 200_000, input_per_million: 1.25, cached_input_per_million: 0.125, output_per_million: 10 },
          { input_per_million: 2.5, cached_input_per_million: 0.25, output_per_million: 15 },
        ],
      },
      'gemini-2.5-flash': {
        currency: 'USD',
        notes: 'text/image/video price; audio is $1.00/M; corrected from 0.15/0.6 on 2026-05-24',
        input_per_million: 0.3,
        cached_input_per_million: 0.03,
        output_per_million: 2.5,
      },
      'gemini-2.5-flash-lite': {
        currency: 'USD',
        notes: 'text/image/video price; audio is $0.30/M',
        input_per_million: 0.1,
        cached_input_per_million: 0.01,
        output_per_million: 0.4,
      },
      'gemini-2.5-flash-lite-preview': {
        currency: 'USD',
        input_per_million: 0.1,
        cached_input_per_million: 0.01,
        output_per_million: 0.4,
      },
      'gemini-2.5-computer-use-preview': {
        currency: 'USD',
        notes: 'tiered by prompt length, 200K threshold',
        tiers: [
          { threshold: 200_000, input_per_million: 1.25, output_per_million: 10 },
          { input_per_million: 2.5, output_per_million: 15 },
        ],
      },

      // ── Gemini 2.0 系列 ──
      'gemini-2.0-flash': {
        currency: 'USD',
        notes: 'text/image/video price; audio is $0.70/M',
        input_per_million: 0.1,
        cached_input_per_million: 0.025,
        output_per_million: 0.4,
      },
      'gemini-2.0-flash-lite': {
        currency: 'USD',
        input_per_million: 0.075,
        output_per_million: 0.3,
      },

      // ── Gemini 1.5（legacy）──
      'gemini-1.5-pro': {
        currency: 'USD',
        notes: 'legacy',
        input_per_million: 1.25,
        cached_input_per_million: 0.3125,
        output_per_million: 5,
      },
      'gemini-1.5-flash': {
        currency: 'USD',
        notes: 'legacy',
        input_per_million: 0.075,
        cached_input_per_million: 0.01875,
        output_per_million: 0.3,
      },

      // ── Robotics / Embedding ──
      'gemini-robotics-er-1.6-preview': {
        currency: 'USD',
        notes: 'text/image/video price; audio is $2.00/M',
        input_per_million: 1,
        output_per_million: 5,
      },
      'gemini-embedding-2': {
        currency: 'USD',
        notes: 'text input only price; image $0.45/M, audio $6.50/M, video $12.00/M',
        input_per_million: 0.2,
        output_per_million: 0,
      },
      'gemini-embedding': {
        currency: 'USD',
        input_per_million: 0.15,
        output_per_million: 0,
      },

      // ── Live API / TTS / Image / Video 走 perfect-fit 模型，按其代表单价；
      //     这些模型的 input/output 不是简单的 text token，应在 scanner 侧匹配。 ──
      'gemini-3.1-flash-live-preview': {
        currency: 'USD',
        notes: 'Live API text price; audio/video/image priced separately',
        input_per_million: 0.75,
        output_per_million: 4.5,
      },
      'gemini-2.5-flash-native-audio': {
        currency: 'USD',
        notes: 'Live API text price; audio is $3.00 input / $12.00 output',
        input_per_million: 0.5,
        output_per_million: 2,
      },
      'gemini-3.1-flash-tts-preview': {
        currency: 'USD',
        notes: 'text in, audio out',
        input_per_million: 1,
        output_per_million: 20,
      },
      'gemini-2.5-flash-preview-tts': {
        currency: 'USD',
        notes: 'text in, audio out',
        input_per_million: 0.5,
        output_per_million: 10,
      },
      'gemini-2.5-pro-preview-tts': {
        currency: 'USD',
        notes: 'text in, audio out',
        input_per_million: 1,
        output_per_million: 20,
      },
      'gemini-3.1-flash-image-preview': {
        currency: 'USD',
        notes: 'text/image in, image out priced per-image',
        input_per_million: 0.5,
        output_per_million: 3,
      },
      'gemini-2.5-flash-image': {
        currency: 'USD',
        notes: 'image out priced per-image ($0.039)',
        input_per_million: 0.3,
        output_per_million: 0,
      },
      'gemini-3-pro-image-preview': {
        currency: 'USD',
        notes: 'image out priced per-image; text-output $12/M',
        input_per_million: 2,
        output_per_million: 12,
      },
    },
  },
};
