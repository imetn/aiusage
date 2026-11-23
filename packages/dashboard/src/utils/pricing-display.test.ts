import assert from 'node:assert/strict';
import test from 'node:test';
import { catalog } from '@aiusage/shared';
import { formatPrice, formatPricingRate } from './pricing-display';

test('formats the actual public catalog fields for AGY without legacy USD field names', () => {
  const model = catalog.providers.google.antigravity.models['gemini-4-neon'];
  assert.equal(formatPricingRate(model, 'input_per_million', catalog.fx), '$3.00');
  assert.equal(formatPricingRate(model, 'cached_input_per_million', catalog.fx), '$0.15');
  assert.equal(formatPricingRate(model, 'output_per_million', catalog.fx), '$15.00');
  assert.equal(formatPricingRate(model, 'cache_write_5m_per_million', catalog.fx), '--');
});

test('shows tier ranges and converts CNY using the catalog exchange rate', () => {
  assert.equal(formatPricingRate({ currency: 'CNY', tiers: [
    { threshold: 200000, input_per_million: 7.2, output_per_million: 72 },
    { input_per_million: 14.4, output_per_million: 144 },
  ] }, 'input_per_million', catalog.fx), '$1.00–$2.00');
});

test('shows the rate effective on the displayed date', () => {
  const model = catalog.providers.google.antigravity.models['gemini-4-carbon'];
  assert.equal(formatPricingRate(model, 'input_per_million', catalog.fx, '2026-11-30'), '$2.00');
  assert.equal(formatPricingRate(model, 'input_per_million', catalog.fx, '2026-12-01'), '$4.00');
});

test('does not throw or invent free rates for missing, non-finite or unsupported prices', () => {
  for (const value of [null, undefined, NaN, Infinity]) assert.equal(formatPrice(value), '--');
  assert.equal(formatPrice(0), '$0.00');
  assert.equal(formatPrice(0.075), '$0.075');
  assert.equal(formatPricingRate({currency:'CNY',input_per_million:7.2}, 'input_per_million', { CNY: 0 }), '--');
});

test('renders every public catalog model in the real pricing table without crashing', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ProductTable } = await import('../pages/pricing-page');
  const { I18N } = await import('../i18n');
  for (const [provider, products] of Object.entries(catalog.providers)) {
    for (const [product, {models}] of Object.entries(products)) {
      const html = renderToStaticMarkup(createElement(ProductTable, {product, models, fx: catalog.fx, isAnthropic: provider === 'anthropic', t: I18N.en}));
      for (const model of Object.keys(models)) assert.ok(html.includes(model), `${provider}/${product}/${model}`);
      assert.ok(!html.includes('undefined') && !html.includes('NaN'));
    }
  }
});
