-- One row per day of the "daily report to management" the CEO Telegram
-- bot already sends (sales/collections/balance summary computed by
-- ceo_agent.py on the sync PC) -- pushed here as a standalone snapshot via
-- POST /api/erp-sync/daily-report, separate from the main /api/erp-sync
-- payload since it's produced on its own daily schedule rather than
-- alongside the other sync tables. Upserted by report_date so a same-day
-- re-push (e.g. a corrected run) replaces rather than duplicates.
CREATE TABLE erp_daily_report (
  report_date DATE PRIMARY KEY,

  sales_ytd_amd NUMERIC, sales_ytd_liters NUMERIC, sales_ytd_orders INT,
  sales_mtd_amd NUMERIC, sales_mtd_liters NUMERIC, sales_mtd_orders INT,
  sales_wtd_amd NUMERIC, sales_wtd_liters NUMERIC, sales_wtd_orders INT,
  sales_day_amd NUMERIC, sales_day_liters NUMERIC, sales_day_orders INT,
  -- Change vs. the previous comparable period -- the source report can
  -- omit these (e.g. "Փոփոխություն նախորդ համադրելի շրջանից՝ վաճառք
  -- չկա"), so nullable rather than defaulted to 0.
  sales_change_amd NUMERIC, sales_change_liters NUMERIC,
  sales_margin_amd NUMERIC, sales_margin_pct NUMERIC,
  -- [{channel_code, amd, liters, orders}] for report_date only.
  sales_by_channel JSONB NOT NULL DEFAULT '[]',

  payments_ytd_amd NUMERIC, payments_ytd_customers INT,
  payments_mtd_amd NUMERIC, payments_mtd_customers INT,
  payments_wtd_amd NUMERIC, payments_wtd_customers INT,
  payments_day_amd NUMERIC, payments_day_customers INT,
  -- [{channel_code, amd, customers}] for report_date only.
  payments_by_channel JSONB NOT NULL DEFAULT '[]',

  balance_amd NUMERIC, balance_usd NUMERIC,
  balance_total_amd NUMERIC, balance_total_usd NUMERIC,
  balance_cash_amd NUMERIC, balance_cash_usd NUMERIC,
  balance_noncash_amd NUMERIC, balance_noncash_usd NUMERIC,
  balance_with_managers_amd NUMERIC,
  -- [{manager_name, amd}]
  balance_with_managers_by_manager JSONB NOT NULL DEFAULT '[]',
  credit_line_usd NUMERIC,
  receivables_total_amd NUMERIC, receivables_net_amd NUMERIC,
  warehouse_value_amd NUMERIC, warehouse_liters NUMERIC,

  prev_report_date DATE,
  change_total_amd NUMERIC,
  change_overdue_amd NUMERIC,

  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
