import assert from 'node:assert/strict';
import test from 'node:test';
import { getMetricAvailability } from './metric-availability';

test('marks pure event-only product selections as unavailable for token and cost metrics', () => {
  const availability = getMetricAvailability({
    selectedProduct: 'copilot-vscode',
    productOptions: [{ value: 'copilot-vscode' }],
    totalEvents: 730,
    totalTokens: 0,
  });

  assert.equal(availability.mode, 'event-only');
  assert.equal(availability.tokenMetricsUnavailable, true);
});

test('keeps gemini-cli selections token-capable even when some older days are event-only', () => {
  const availability = getMetricAvailability({
    selectedProduct: 'gemini-cli',
    productOptions: [{ value: 'gemini-cli' }],
    totalEvents: 1230,
    totalTokens: 93_200_000,
  });

  assert.equal(availability.mode, 'standard');
  assert.equal(availability.tokenMetricsUnavailable, false);
});

test('does not mark mixed product sets as unavailable when a token-bearing product is present', () => {
  const availability = getMetricAvailability({
    selectedProduct: '',
    productOptions: [
      { value: 'gemini-cli' },
      { value: 'copilot-vscode' },
    ],
    totalEvents: 1960,
    totalTokens: 93_200_000,
  });

  assert.equal(availability.mode, 'standard');
  assert.equal(availability.tokenMetricsUnavailable, false);
});

test('supports multi-selected event-only product filters', () => {
  const availability = getMetricAvailability({
    selectedProduct: ['copilot-vscode', 'antigravity'],
    productOptions: [
      { value: 'copilot-vscode' },
      { value: 'antigravity' },
    ],
    totalEvents: 817,
    totalTokens: 0,
  });

  assert.equal(availability.mode, 'event-only');
  assert.equal(availability.tokenMetricsUnavailable, true);
});


test('shows Antigravity token metrics when SQLite usage exists alongside legacy events', () => {
  const availability = getMetricAvailability({
    selectedProduct: 'antigravity', productOptions: [{ value: 'antigravity' }],
    totalEvents: 51, totalTokens: 1234,
  });
  assert.equal(availability.mode, 'standard');
  assert.equal(availability.tokenMetricsUnavailable, false);
});
