-- Company Dashboard's This Week per-rep sales/collected breakdown needs the
-- same [{channel_code, amd, ...}] shape erp_daily_report already carries for
-- "today" (sales_by_channel/payments_by_channel), but scoped to the week
-- instead of report_date. The sync PC's daily-report push (ceo_agent.py)
-- doesn't send this yet -- these columns exist so POST /api/erp-sync/daily-report
-- can start accepting it once that script is updated to compute it from the
-- same Cash/Sales sheet it already reads wtd_amd from; until then these
-- default to '[]' and the dashboard simply shows no per-rep breakdown for
-- This Week, same as before this migration.
ALTER TABLE erp_daily_report
  ADD COLUMN sales_by_channel_wtd JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN payments_by_channel_wtd JSONB NOT NULL DEFAULT '[]';
