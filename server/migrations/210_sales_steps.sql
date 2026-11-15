-- Vaghinak - Sales Expert, step 2 (owner, 2026-11-15): every Monday the 5 best next steps per sales manager (team/vaghinak/nextSteps.js).
-- Shadow first (only management sees the picks); in live mode each pick is also a task (auto_kind 'sales_step').
CREATE TABLE IF NOT EXISTS sales_step_picks (
  id          SERIAL PRIMARY KEY,
  week_start  DATE NOT NULL,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  rep_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  params      JSONB NOT NULL DEFAULT '{}'::jsonb,
  value       INTEGER NOT NULL DEFAULT 0,
  task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (week_start, customer_id)
);
CREATE INDEX IF NOT EXISTS sales_step_picks_week_idx ON sales_step_picks (week_start);

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_auto_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_auto_kind_check CHECK (auto_kind IN
  ('debt_collection', 'reorder_followup', 'dead_stock', 'fx_review', 'excel_upload', 'data_quality', 'data_missing', 'order_waiting', 'downpayment',
   'cash_handoff_unconfirmed', 'cash_sheet_not_recorded', 'cash_discrepancy', 'order_not_in_excel', 'document_unsigned', 'cancel_putback', 'sales_step'));
