-- Owner, 2026-11-11: a delivered app order the Excel still does not show 14 days after delivery (on the Excel's own clock: its newest order) stops
-- holding stock and gets a "Not in Excel" flag; it STAYS delivered (moving it back would undo the delivery in the debt, the tasks and the
-- reports). The accountant gets one open task listing those orders; the flag goes away by itself when the sync finds the order in the Excel
-- or the accountant marks it recorded.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS not_in_excel_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS orders_not_in_excel_idx ON orders (not_in_excel_at) WHERE not_in_excel_at IS NOT NULL;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_auto_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_auto_kind_check CHECK (auto_kind IN
  ('debt_collection', 'reorder_followup', 'dead_stock', 'fx_review', 'excel_upload', 'data_quality', 'data_missing', 'order_waiting', 'downpayment',
   'cash_handoff_unconfirmed', 'cash_sheet_not_recorded', 'cash_discrepancy', 'order_not_in_excel'));
