-- Links a Field Visits customer to its record in the Castrol Excel/ERP
-- workbook (the same source the CEO Telegram bot reports from), and stores
-- the latest pushed extract of debt/AR and recent-order data for it.
-- erp_customer_data is fully replaced on every sync (see server/src/routes/erpSync.js)
-- rather than merged row by row, so a customer that drops out of the ERP
-- extract (e.g. debt fully paid, no recent orders) doesn't show stale data.
ALTER TABLE customers ADD COLUMN erp_customer_id TEXT;
CREATE INDEX idx_customers_erp_customer_id ON customers (erp_customer_id)
  WHERE erp_customer_id IS NOT NULL;

CREATE TABLE erp_customer_data (
  erp_customer_id     TEXT PRIMARY KEY,
  assigned_sales_rep  TEXT,
  debt_amd            NUMERIC,
  last_payment_date   DATE,
  days_since_payment  INTEGER,
  aging_bucket        TEXT,
  recent_orders       JSONB NOT NULL DEFAULT '[]',
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
