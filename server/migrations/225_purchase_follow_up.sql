-- Purchases follow-up (owner, 2026-11-26, roadmap PR 4): an Ordered / On the way purchase past its expected date gives a task
-- ("purchase_late") to the person who entered it (else the accountants), once per expected date: late_task_for keeps the date the task was
-- made for, so a new date that passes again makes a new task. Additive.
ALTER TABLE purchase_invoices ADD COLUMN IF NOT EXISTS late_task_for date;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_auto_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_auto_kind_check CHECK (auto_kind IN
  ('debt_collection', 'reorder_followup', 'dead_stock', 'fx_review', 'excel_upload', 'data_quality', 'data_missing', 'order_waiting', 'downpayment',
   'cash_handoff_unconfirmed', 'cash_sheet_not_recorded', 'cash_discrepancy', 'order_not_in_excel', 'document_unsigned', 'cancel_putback', 'sales_step',
   'cash_balance_check', 'purchase_difference', 'purchase_late'));
