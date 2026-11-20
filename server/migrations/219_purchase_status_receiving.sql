-- Purchases P5 (owner, 2026-11-20): Ordered -> On the way -> Arrived, the expected date, and the count on arrival.
-- Owner decisions: the warehouse and the office both receive (the warehouse without prices); pieces Ordered / On the way are subtracted
-- from Warehouse > To order; a count that differs from the invoice is shown and gives the accountant a task; a purchase can be Ordered
-- before the supplier's invoice exists (no number, no rate yet). Every invoice there is today is "arrived". Additive.
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'arrived';
ALTER TABLE purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_status_check;
ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_status_check CHECK (status IN ('ordered', 'in_transit', 'arrived'));
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS expected_date DATE;
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS arrived_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS arrival_note TEXT;

-- an Ordered purchase may have no invoice number and no rate yet; On the way it has both. Goods can ARRIVE before the paper (the warehouse
-- counts them; it cannot type a rate): an arrived purchase without its paper is shown as "paper missing" until the office adds it.
ALTER TABLE purchase_invoices ALTER COLUMN invoice_no DROP NOT NULL;
ALTER TABLE purchase_invoices ALTER COLUMN usd_rate DROP NOT NULL;
ALTER TABLE purchase_invoices DROP CONSTRAINT IF EXISTS purchase_invoices_paper_check;
ALTER TABLE purchase_invoices ADD CONSTRAINT purchase_invoices_paper_check
  CHECK (status <> 'in_transit' OR (invoice_no IS NOT NULL AND btrim(invoice_no) <> '' AND usd_rate IS NOT NULL));

-- the pieces counted on arrival (NULL = not counted)
ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS received_qty NUMERIC(12, 3) CHECK (received_qty IS NULL OR received_qty >= 0);

-- the history knows the arrival; the accountant's task for a difference
ALTER TABLE purchase_log DROP CONSTRAINT IF EXISTS purchase_log_action_check;
ALTER TABLE purchase_log ADD CONSTRAINT purchase_log_action_check CHECK (action IN ('create', 'update', 'delete', 'file_add', 'file_delete', 'status', 'receive'));
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_auto_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_auto_kind_check CHECK (auto_kind IN
  ('debt_collection', 'reorder_followup', 'dead_stock', 'fx_review', 'excel_upload', 'data_quality', 'data_missing', 'order_waiting', 'downpayment',
   'cash_handoff_unconfirmed', 'cash_sheet_not_recorded', 'cash_discrepancy', 'order_not_in_excel', 'document_unsigned', 'cancel_putback', 'sales_step',
   'cash_balance_check', 'purchase_difference'));

CREATE INDEX IF NOT EXISTS purchase_invoices_open_idx ON purchase_invoices (status) WHERE status <> 'arrived';
