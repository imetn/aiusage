import type { ModelPricing, PricingCatalog } from '@aiusage/shared';

type RateField = 'input_per_million' | 'output_per_million' | 'cached_input_per_million'
  | 'cache_write_5m_per_million' | 'cache_write_1h_per_million';

export function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '--';
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: false })}`;
}

export function formatPricingRate(
  model: ModelPricing,
  field: RateField,
  fx: PricingCatalog['fx'],
  day = new Date().toISOString().slice(0, 10),
): string {
  let active = model;
  for (const change of model.price_changes ?? []) {
    if (change.effective_from <= day) active = { ...active, ...change };
  }
  const exchangeRate = model.currency === 'USD' ? 1 : fx[model.currency];
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) return '--';
  const rates = (active.tiers?.length ? active.tiers : [active])
    .map(tier => tier[field] ?? active[field])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .map(value => value / exchangeRate);
  if (!rates.length) return '--';
  const min = Math.min(...rates), max = Math.max(...rates);
  return min === max ? formatPrice(min) : `${formatPrice(min)}–${formatPrice(max)}`;
}
