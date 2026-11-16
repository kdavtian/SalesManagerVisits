-- Excel "Balance" rows -> the app's cash handovers (owner, 2026-11-16). In the Cashflow sheet a rep's cash reaching the office is a pair:
-- -X on the rep's cash box and +X on the office "Cash" box, same or next day. After each Excel upload (money/excelBalance.js) the app:
--   * confirms the rep's pending handover of exactly X to the accountant, or
--   * creates and confirms one from the rep's cash in hand when it adds up to exactly X (owner: "if recorded in Excel > create handover"),
--   * otherwise gives the accountant a task (owner: "Task").
-- Test mode first: in "shadow" it only writes down what it would do.
ALTER TABLE cash_handoffs ADD COLUMN IF NOT EXISTS from_excel BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS excel_balance_mode TEXT NOT NULL DEFAULT 'shadow';
ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_excel_balance_mode_check;
ALTER TABLE app_settings ADD CONSTRAINT app_settings_excel_balance_mode_check CHECK (excel_balance_mode IN ('off', 'shadow', 'live'));

-- One row per Balance pair and mode: the Excel rows are re-inserted on every upload (new ids), so a pair is known by its content
-- (date | amount | from box | to box | n-th identical pair). A pair acted on in "live" is never acted on again.
CREATE TABLE IF NOT EXISTS excel_balance_links (
  id           SERIAL PRIMARY KEY,
  pair_key     TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('shadow', 'live')),
  entry_date   DATE NOT NULL,
  amount_amd   NUMERIC(14, 2) NOT NULL,
  from_account TEXT NOT NULL,
  to_account   TEXT NOT NULL,
  rep_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('confirmed_existing', 'created', 'task')),
  handoff_id   INTEGER REFERENCES cash_handoffs(id) ON DELETE SET NULL,
  detail       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (pair_key, mode)
);
CREATE INDEX IF NOT EXISTS excel_balance_links_created_idx ON excel_balance_links (created_at DESC);

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_auto_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_auto_kind_check CHECK (auto_kind IN
  ('debt_collection', 'reorder_followup', 'dead_stock', 'fx_review', 'excel_upload', 'data_quality', 'data_missing', 'order_waiting', 'downpayment',
   'cash_handoff_unconfirmed', 'cash_sheet_not_recorded', 'cash_discrepancy', 'order_not_in_excel', 'document_unsigned', 'cancel_putback', 'sales_step',
   'cash_balance_check'));
