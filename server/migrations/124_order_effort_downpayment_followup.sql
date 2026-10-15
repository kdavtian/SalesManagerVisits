-- 1.338.0. (1) How the rep made the order, measured on the device and sent with it: where it started
-- (new / usual / repeat), seconds from opening the order screen to Save, and taps. Three small integers per order,
-- no extra request; the Operations -> Order flow tab shows medians and the share made via "usual" so management can
-- see whether the ordering shortcuts really save time. (2) Vaghinak's downpayment follow-up: how many reminders were
-- sent and when the last one went out (at most one a day, three in all), plus its own automatic task kind.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_source TEXT CHECK (order_source IS NULL OR order_source IN ('new', 'usual', 'repeat'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS build_seconds INTEGER CHECK (build_seconds IS NULL OR build_seconds BETWEEN 0 AND 86400);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS build_taps INTEGER CHECK (build_taps IS NULL OR build_taps BETWEEN 0 AND 10000);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS downpayment_reminders INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS downpayment_reminded_on DATE;

ALTER TABLE tasks DROP CONSTRAINT tasks_auto_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_auto_kind_check CHECK (auto_kind IN
  ('debt_collection', 'reorder_followup', 'dead_stock', 'fx_review', 'excel_upload', 'data_quality', 'data_missing', 'order_waiting', 'downpayment'));
