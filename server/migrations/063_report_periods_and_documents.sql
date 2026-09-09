-- Two things requested together: (1) let erp_daily_report hold more than
-- just the "daily" period, so the CEO Telegram bot's weekly/monthly/
-- quarterly/annual management reports can be browsed in-app the same way
-- the daily one already is; (2) a place to land the actual generated Excel
-- files (Sales Director report, debt/receivables workbook, ...) as
-- downloadable documents, since re-deriving those multi-sheet workbooks as
-- native in-app screens would just duplicate -- and risk drifting from --
-- logic the Python pipeline already gets right.

ALTER TABLE erp_daily_report ADD COLUMN period TEXT NOT NULL DEFAULT 'daily';
ALTER TABLE erp_daily_report ADD CONSTRAINT erp_daily_report_period_check
  CHECK (period IN ('daily', 'weekly', 'monthly', 'quarterly', 'annual'));

-- report_date alone was unique enough when every row was implicitly
-- "daily" -- now a weekly and a monthly snapshot can legitimately share a
-- report_date, so the key has to include period.
ALTER TABLE erp_daily_report DROP CONSTRAINT erp_daily_report_pkey;
ALTER TABLE erp_daily_report ADD PRIMARY KEY (period, report_date);

-- File-based reports the bot already builds correctly in Python (Sales
-- Director workbook, debt/receivables Excel, ...) -- pushed here as the
-- literal generated file rather than re-parsed into structured columns.
-- Stored in the DB directly (bytea), same as photo/attachment blobs
-- elsewhere in this app: these are a few hundred KB each, not worth a
-- separate object-storage dependency for.
CREATE TABLE generated_reports (
  id SERIAL PRIMARY KEY,
  report_type TEXT NOT NULL CHECK (report_type IN ('sales_director', 'debt_receivables', 'ceo_management')),
  report_date DATE NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  file_data BYTEA NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A same-day re-push (a corrected run) replaces rather than piling up
-- duplicates -- same upsert-by-date pattern as erp_daily_report itself.
CREATE UNIQUE INDEX generated_reports_type_date_uidx ON generated_reports (report_type, report_date);
CREATE INDEX generated_reports_type_date_idx ON generated_reports (report_type, report_date DESC);
