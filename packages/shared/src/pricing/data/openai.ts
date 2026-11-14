import type { ProductPricing } from '../types.js';

/**
 * OpenAI（Codex / GPT 系列）。
 * 单价 USD / 1M tokens。来源：
 * - https://developers.openai.com/api/docs/models/gpt-6-astra
 * - https://developers.openai.com/api/docs/models/gpt-6-sol
 * - https://developers.openai.com/api/docs/models/gpt-6-luna
 * - https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * 最近核对：2026-09-24
 *
 * 注意：deep-research 与 computer-use 此前在 worker/cli 表里写高了 2 倍，本次已校正。
 */
export const openai: Record<string, ProductPricing> = {
  codex: {
    models: {
      // ── GPT-6 系列 ──
      // https://developers.openai.com/api/docs/models/gpt-6.1-terra (2026-11-14)
      'gpt-6.1-terra': {
        currency: 'USD',
        notes: 'prompts over 272K input tokens bill the full request at long-context rates; cache write uses the 30-minute rate',
        input_per_million: 1,
        cached_input_per_million: 0.05,
        cache_write_per_million: 1.25,
        output_per_million: 5,
        tiers: [
          { threshold: 272_000, input_per_million: 1, cached_input_per_million: 0.05, cache_write_per_million: 1.25, output_per_million: 5 },
          { input_per_million: 2, cached_input_per_million: 0.1, cache_write_per_million: 2.5, output_per_million: 7.5 },
        ],
      },
      // https://developers.openai.com/api/docs/models/gpt-6.1-sol (2026-10-20)
      'gpt-6.1-sol': {
        currency: 'USD',
        notes: 'prompts over 272K input tokens bill the full request at long-context rates',
        input_per_million: 2,
        cached_input_per_million: 0.1,
        cache_write_per_million: 2.5,
        output_per_million: 10,
        tiers: [
          { threshold: 272_000, input_per_million: 2, cached_input_per_million: 0.1, cache_write_per_million: 2.5, output_per_million: 10 },
          { input_per_million: 4, cached_input_per_million: 0.2, cache_write_per_million: 5, output_per_million: 15 },
        ],
      },
      'gpt-6-astra': {
        currency: 'USD',
        notes: 'prompts over 272K input tokens bill the full request at long-context rates',
        input_per_million: 10,
        cached_input_per_million: 1,
        cache_write_per_million: 12.5,
        output_per_million: 50,
        tiers: [
          {
            threshold: 272_000,
            input_per_million: 10,
            cached_input_per_million: 1,
            cache_write_per_million: 12.5,
            output_per_million: 50,
          },
          {
            input_per_million: 20,
            cached_input_per_million: 2,
            cache_write_per_million: 25,
            output_per_million: 75,
          },
        ],
      },
      'gpt-6-sol': {
        currency: 'USD',
        notes: 'prompts over 272K input tokens bill the full request at long-context rates',
        input_per_million: 2,
        cached_input_per_million: 0.2,
        cache_write_per_million: 2.5,
        output_per_million: 10,
        tiers: [
          {
            threshold: 272_000,
            input_per_million: 2,
            cached_input_per_million: 0.2,
            cache_write_per_million: 2.5,
            output_per_million: 10,
          },
          {
            input_per_million: 4,
            cached_input_per_million: 0.4,
            cache_write_per_million: 5,
            output_per_million: 15,
          },
        ],
      },
      'gpt-6-luna': {
        currency: 'USD',
        notes: 'prompts over 272K input tokens bill the full request at long-context rates',
        input_per_million: 0.1,
        cached_input_per_million: 0.01,
        cache_write_per_million: 0.125,
        output_per_million: 0.5,
        tiers: [
          {
            threshold: 272_000,
            input_per_million: 0.1,
            cached_input_per_million: 0.01,
            cache_write_per_million: 0.125,
            output_per_million: 0.5,
          },
          {
            input_per_million: 0.2,
            cached_input_per_million: 0.02,
            cache_write_per_million: 0.25,
            output_per_million: 0.75,
          },
        ],
      },

      // ── GPT-5.6 系列 ──
      'gpt-5.6-sol': {
        currency: 'USD',
        notes: 'promotional pricing available at least through 2026-11-21; prompts over 272K input tokens bill the full request at long-context rates',
        input_per_million: 4,
        cached_input_per_million: 0.4,
        cache_write_per_million: 5,
        output_per_million: 20,
        tiers: [
          {
            threshold: 272_000,
            input_per_million: 4,
            cached_input_per_million: 0.4,
            cache_write_per_million: 5,
            output_per_million: 20,
          },
          {
            input_per_million: 8,
            cached_input_per_million: 0.8,
            cache_write_per_million: 10,
            output_per_million: 30,
          },
        ],
      },
      'gpt-5.6-terra': {
        currency: 'USD',
        notes: 'prompts over 272K input tokens bill the full request at long-context rates',
        input_per_million: 2,
        cached_input_per_million: 0.2,
        cache_write_per_million: 2.5,
        output_per_million: 12,
        tiers: [
          {
            threshold: 272_000,
            input_per_million: 2,
            cached_input_per_million: 0.2,
            cache_write_per_million: 2.5,
            output_per_million: 12,
          },
          {
            input_per_million: 4,
            cached_input_per_million: 0.4,
            cache_write_per_million: 5,
            output_per_million: 18,
          },
        ],
      },
      'gpt-5.6-luna': {
        currency: 'USD',
        notes: 'prompts over 272K input tokens bill the full request at long-context rates',
        input_per_million: 0.2,
        cached_input_per_million: 0.02,
        cache_write_per_million: 0.25,
        output_per_million: 1.2,
        tiers: [
          {
            threshold: 272_000,
            input_per_million: 0.2,
            cached_input_per_million: 0.02,
            cache_write_per_million: 0.25,
            output_per_million: 1.2,
          },
          {
            input_per_million: 0.4,
            cached_input_per_million: 0.04,
            cache_write_per_million: 0.5,
            output_per_million: 1.8,
          },
        ],
      },

      // ── GPT-5.5 系列 ──
      'gpt-5.5': {
        currency: 'USD',
        notes: 'prompts over 272K input tokens bill the full request at long-context rates',
        input_per_million: 5,
        cached_input_per_million: 0.5,
        output_per_million: 30,
        tiers: [
          {
            threshold: 272_000,
            input_per_million: 5,
            cached_input_per_million: 0.5,
            output_per_million: 30,
          },
          {
            input_per_million: 10,
            cached_input_per_million: 1,
            output_per_million: 45,
          },
        ],
      },
      'gpt-5.5-pro': {
        currency: 'USD',
        notes: 'prompts over 272K input tokens bill the full request at long-context rates',
        input_per_million: 30,
        cached_input_per_million: null,
        output_per_million: 180,
        tiers: [
          {
            threshold: 272_000,
            input_per_million: 30,
            cached_input_per_million: null,
            output_per_million: 180,
          },
          {
            input_per_million: 60,
            cached_input_per_million: null,
            output_per_million: 270,
          },
        ],
      },

      // ── GPT-5.4 系列 ──
      'gpt-5.4': {
        currency: 'USD',
        notes: 'prompts over 272K input tokens bill the full request at long-context rates',
        input_per_million: 2.5,
        cached_input_per_million: 0.25,
        output_per_million: 15,
        tiers: [
          {
            threshold: 272_000,
            input_per_million: 2.5,
            cached_input_per_million: 0.25,
            output_per_million: 15,
          },
          {
            input_per_million: 5,
            cached_input_per_million: 0.5,
            output_per_million: 22.5,
          },
        ],
      },
      'gpt-5.4-mini': {
        currency: 'USD',
        input_per_million: 0.75,
        cached_input_per_million: 0.075,
        output_per_million: 4.5,
      },
      'gpt-5.4-nano': {
        currency: 'USD',
        input_per_million: 0.2,
        cached_input_per_million: 0.02,
        output_per_million: 1.25,
      },
      'gpt-5.4-pro': {
        currency: 'USD',
        notes: 'prompts over 272K input tokens bill the full request at long-context rates',
        input_per_million: 30,
        cached_input_per_million: null,
        output_per_million: 180,
        tiers: [
          {
            threshold: 272_000,
            input_per_million: 30,
            cached_input_per_million: null,
            output_per_million: 180,
          },
          {
            input_per_million: 60,
            cached_input_per_million: null,
            output_per_million: 270,
          },
        ],
      },

      // ── GPT-5.3 / 5.2 / Codex 变体 ──
      'gpt-5.3-codex': {
        currency: 'USD',
        input_per_million: 1.75,
        cached_input_per_million: 0.175,
        output_per_million: 14,
      },
      'gpt-5.2-codex': {
        currency: 'USD',
        input_per_million: 1.75,
        cached_input_per_million: 0.175,
        output_per_million: 14,
      },
      'gpt-5.2-pro': {
        currency: 'USD',
        input_per_million: 21,
        cached_input_per_million: null,
        output_per_million: 168,
      },
      'gpt-5.2': {
        currency: 'USD',
        input_per_million: 1.75,
        cached_input_per_million: 0.175,
        output_per_million: 14,
      },

      // ── GPT-5.1 / 5 系列 ──
      'gpt-5.1-codex-max': {
        currency: 'USD',
        input_per_million: 1.25,
        cached_input_per_million: 0.125,
        output_per_million: 10,
      },
      'gpt-5.1-codex-mini': {
        currency: 'USD',
        input_per_million: 0.25,
        cached_input_per_million: 0.025,
        output_per_million: 2,
      },
      'gpt-5.1-codex': {
        currency: 'USD',
        input_per_million: 1.25,
        cached_input_per_million: 0.125,
        output_per_million: 10,
      },
      'gpt-5.1': {
        currency: 'USD',
        input_per_million: 1.25,
        cached_input_per_million: 0.125,
        output_per_million: 10,
      },
      'gpt-5-pro': {
        currency: 'USD',
        input_per_million: 15,
        cached_input_per_million: null,
        output_per_million: 120,
      },
      'gpt-5-codex': {
        currency: 'USD',
        input_per_million: 1.25,
        cached_input_per_million: 0.125,
        output_per_million: 10,
      },
      'gpt-5-mini': {
        currency: 'USD',
        input_per_million: 0.25,
        cached_input_per_million: 0.025,
        output_per_million: 2,
      },
      'gpt-5-nano': {
        currency: 'USD',
        input_per_million: 0.05,
        cached_input_per_million: 0.005,
        output_per_million: 0.4,
      },
      'gpt-5': {
        currency: 'USD',
        input_per_million: 1.25,
        cached_input_per_million: 0.125,
        output_per_million: 10,
      },

      // ── GPT-4.1 / 4o ──
      'gpt-4.1': { currency: 'USD', input_per_million: 2, cached_input_per_million: 0.5, output_per_million: 8 },
      'gpt-4.1-mini': { currency: 'USD', input_per_million: 0.4, cached_input_per_million: 0.1, output_per_million: 1.6 },
      'gpt-4.1-nano': { currency: 'USD', input_per_million: 0.1, cached_input_per_million: 0.025, output_per_million: 0.4 },
      'gpt-4o': { currency: 'USD', input_per_million: 2.5, cached_input_per_million: 1.25, output_per_million: 10 },
      'gpt-4o-mini': { currency: 'USD', input_per_million: 0.15, cached_input_per_million: 0.075, output_per_million: 0.6 },
      'gpt-4o-2024-05-13': { currency: 'USD', input_per_million: 5, cached_input_per_million: null, output_per_million: 15 },

      // ── o 系列 ──
      'o1-pro': { currency: 'USD', input_per_million: 150, cached_input_per_million: null, output_per_million: 600 },
      'o1': { currency: 'USD', input_per_million: 15, cached_input_per_million: 7.5, output_per_million: 60 },
      'o1-mini': { currency: 'USD', input_per_million: 1.1, cached_input_per_million: 0.55, output_per_million: 4.4 },
      'o3-pro': { currency: 'USD', input_per_million: 20, cached_input_per_million: null, output_per_million: 80 },
      'o3': { currency: 'USD', input_per_million: 2, cached_input_per_million: 0.5, output_per_million: 8 },
      'o3-mini': { currency: 'USD', input_per_million: 1.1, cached_input_per_million: 0.55, output_per_million: 4.4 },
      'o4-mini': { currency: 'USD', input_per_million: 1.1, cached_input_per_million: 0.275, output_per_million: 4.4 },

      // ── Deep research / 工具型 ──
      'o3-deep-research': {
        currency: 'USD',
        notes: 'corrected from previous 10/40 entry on 2026-05-24',
        input_per_million: 5,
        cached_input_per_million: null,
        output_per_million: 20,
      },
      'o4-mini-deep-research': {
        currency: 'USD',
        notes: 'corrected from previous 2/8 entry on 2026-05-24',
        input_per_million: 1,
        cached_input_per_million: null,
        output_per_million: 4,
      },
      'computer-use-preview': {
        currency: 'USD',
        notes: 'corrected from previous 3/12 entry on 2026-05-24',
        input_per_million: 1.5,
        cached_input_per_million: null,
        output_per_million: 6,
      },

      // ── 历史模型（GPT-4 / 3.5 / davinci 等）──
      'gpt-4-turbo-2024-04-09': { currency: 'USD', input_per_million: 10, cached_input_per_million: null, output_per_million: 30 },
      'gpt-4-0125-preview': { currency: 'USD', input_per_million: 10, cached_input_per_million: null, output_per_million: 30 },
      'gpt-4-1106-preview': { currency: 'USD', input_per_million: 10, cached_input_per_million: null, output_per_million: 30 },
      'gpt-4-1106-vision-preview': { currency: 'USD', input_per_million: 10, cached_input_per_million: null, output_per_million: 30 },
      'gpt-4-0613': { currency: 'USD', input_per_million: 30, cached_input_per_million: null, output_per_million: 60 },
      'gpt-4-0314': { currency: 'USD', input_per_million: 30, cached_input_per_million: null, output_per_million: 60 },
      'gpt-4-32k': { currency: 'USD', input_per_million: 60, cached_input_per_million: null, output_per_million: 120 },
      'gpt-3.5-turbo': { currency: 'USD', input_per_million: 0.5, cached_input_per_million: null, output_per_million: 1.5 },
      'gpt-3.5-turbo-0125': { currency: 'USD', input_per_million: 0.5, cached_input_per_million: null, output_per_million: 1.5 },
      'gpt-3.5-turbo-1106': { currency: 'USD', input_per_million: 1, cached_input_per_million: null, output_per_million: 2 },
      'gpt-3.5-turbo-0613': { currency: 'USD', input_per_million: 1.5, cached_input_per_million: null, output_per_million: 2 },
      'gpt-3.5-0301': { currency: 'USD', input_per_million: 1.5, cached_input_per_million: null, output_per_million: 2 },
      'gpt-3.5-turbo-instruct': { currency: 'USD', input_per_million: 1.5, cached_input_per_million: null, output_per_million: 2 },
      'gpt-3.5-turbo-16k-0613': { currency: 'USD', input_per_million: 3, cached_input_per_million: null, output_per_million: 4 },
      'davinci-002': { currency: 'USD', input_per_million: 2, cached_input_per_million: null, output_per_million: 2 },
      'babbage-002': { currency: 'USD', input_per_million: 0.4, cached_input_per_million: null, output_per_million: 0.4 },
      'codex-mini-latest': { currency: 'USD', input_per_million: 1.5, cached_input_per_million: 0.375, output_per_million: 6 },

      // ── Embeddings ──
      'text-embedding-3-small': { currency: 'USD', input_per_million: 0.02, cached_input_per_million: null, output_per_million: 0 },
      'text-embedding-3-large': { currency: 'USD', input_per_million: 0.13, cached_input_per_million: null, output_per_million: 0 },
      'text-embedding-ada-002': { currency: 'USD', input_per_million: 0.1, cached_input_per_million: null, output_per_million: 0 },
    },
  },
};
