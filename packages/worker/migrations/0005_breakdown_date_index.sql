-- Dashboard queries filter daily_usage_breakdown by usage_date without a
-- device_id, so neither the primary key nor the dimension indexes can serve
-- them and every query scanned the whole table.
CREATE INDEX IF NOT EXISTS idx_breakdown_date ON daily_usage_breakdown(usage_date);

-- Finding rows that are still unpriced (to reprice them) reads only this partial index.
CREATE INDEX IF NOT EXISTS idx_breakdown_unavailable
  ON daily_usage_breakdown(cost_status)
  WHERE cost_status = 'unavailable';
