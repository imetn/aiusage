import { describe, expect, it } from 'vitest';
import { calculateCost, catalog } from '../pricing/index.js';

const tokens = { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 1_000_000 };

describe('Antigravity API reference prices', () => {
  it.each([
    ['gemini-4-neon-xhigh', 18.15],
    ['gemini-4-carbon-low', 12.1],
    ['gemini-4-argon-high', 12.1],
    ['gemini-4-hydrogen-medium', 9.075],
    ['gemini-3.8-flash-high', 4.575],
  ])('prices %s without multiplying reasoning effort', (model, expected) => {
    const result = calculateCost('google', 'antigravity', model, tokens, { usageTime: '2026-11-23' });
    expect(result.estimatedCostUsd).toBe(expected);
    expect(result.costStatus).toBe('estimated');
    expect(catalog.providers.google.antigravity.models[result.resolvedModel!]).toBeDefined();
  });

  it.each(['gemini-4-carbon', 'gemini-4-argon'])('retains introductory history and applies the announced future price for %s', model => {
    const cost = (day: string) => calculateCost('google', 'antigravity', model, tokens, { usageTime: day }).estimatedCostUsd;
    expect(cost('2026-11-30')).toBe(12.1);
    expect(cost('2026-12-01')).toBe(24.2);
    expect(cost('2026-11-23')).toBe(12.1);
  });


  it('marks direct Gemini daily aggregates near a price cutover estimated', () => {
    for (const day of ['2026-11-30', '2026-12-01']) {
      expect(calculateCost('google', 'gemini-cli', 'gemini-4-carbon', tokens, { usageTime: day }).costStatus).toBe('estimated');
    }
    expect(calculateCost('google', 'gemini-cli', 'gemini-4-carbon', tokens, { usageTime: '2026-11-23' }).costStatus).toBe('exact');
  });

  it('changes Flash prices on January 1 and accepts timestamped usage', () => {
    expect(calculateCost('google', 'antigravity', 'gemini-3.8-flash', tokens, { usageTime: Date.parse('2026-12-31T12:00:00Z') }).estimatedCostUsd).toBe(4.575);
    expect(calculateCost('google', 'antigravity', 'gemini-3.8-flash', tokens, { usageTime: '2027-01-01' }).estimatedCostUsd).toBe(9.15);
  });

  it.each(['claude-opus-5-5', 'claude-sonnet-5-5'])('uses the Claude API reference for %s while marking subscription costs estimated', model => {
    const direct = calculateCost('anthropic', 'claude-code', model, tokens);
    const result = calculateCost('anthropic', 'antigravity', `${model}-high`, tokens);
    expect(result.estimatedCostUsd).toBe(direct.estimatedCostUsd);
    expect(result.costStatus).toBe('estimated');
    expect(catalog.providers.anthropic.antigravity.models[model]).toBeDefined();
  });

  it.each(['gpt-oss-120b-medium', 'gemini-pro-orchestrator', 'antigravity-model-12345'])('does not invent a price for %s', model => {
    const result = calculateCost('google', 'antigravity', model, tokens);
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.costStatus).toBe('unavailable');
  });
});
