-- Brand-volume actuals, computed by the same Python pipeline that already
-- produces sales_performance (Sales/Collected/Budget) on every sync --
-- reusing that existing table for Sales + Collections actuals rather than
-- duplicating it here (see teamPerformance.js, which joins
-- sales_performance.rep_name to sales_channels.code). This table only adds
-- what doesn't exist anywhere yet: normalized liters per channel/brand/
-- month. Truncated and replaced whole on every sync, same pattern as
-- sales_performance and erp_order_lines.
CREATE TABLE perf_actuals_brand_monthly (
  id SERIAL PRIMARY KEY,
  channel_code TEXT NOT NULL,
  month DATE NOT NULL,
  brand TEXT NOT NULL,
  liters NUMERIC NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_code, month, brand)
);
CREATE INDEX idx_perf_actuals_brand_monthly_month ON perf_actuals_brand_monthly (month);

-- New-customer counts are NOT pushed by the Python pipeline -- "new" means
-- "first ever appearance in this app's synced history" (see
-- erp_customer_first_seen, migration 037), which only Field Visits' own
-- database can know since a single Excel snapshot has no memory of prior
-- syncs. Counting per channel/month needs assigned_sales_rep indexed.
CREATE INDEX idx_erp_customer_data_assigned_sales_rep ON erp_customer_data (assigned_sales_rep);
