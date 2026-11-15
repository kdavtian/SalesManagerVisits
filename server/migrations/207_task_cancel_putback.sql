-- Owner, 2026-11-14: a packed order that is cancelled gives the warehouse manager a task "put the goods back" at once (it closes by itself when
-- the warehouse confirms the goods are back on the shelf). New automatic task kind 'cancel_putback'.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_auto_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_auto_kind_check CHECK (auto_kind IN
  ('debt_collection', 'reorder_followup', 'dead_stock', 'fx_review', 'excel_upload', 'data_quality', 'data_missing', 'order_waiting', 'downpayment',
   'cash_handoff_unconfirmed', 'cash_sheet_not_recorded', 'cash_discrepancy', 'order_not_in_excel', 'document_unsigned', 'cancel_putback'));
