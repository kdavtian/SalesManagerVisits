-- Full all-time "Oil order" Cashflow history per ERP customer (signed
-- amount -- a positive row is a payment received, a negative one a
-- refund paid back out), pushed alongside erp_order_lines so a customer's
-- debt as of any past date can be computed as a running balance:
-- SUM(erp_order_lines.revenue_amd WHERE order_date <= D)
--   - SUM(erp_cashflow_lines.amount_amd WHERE cashflow_date <= D)
-- Replaced wholesale on every sync, same as erp_order_lines.
CREATE TABLE erp_cashflow_lines (
  id                SERIAL PRIMARY KEY,
  erp_customer_id   TEXT NOT NULL,
  cashflow_date     DATE NOT NULL,
  amount_amd        NUMERIC
);

CREATE INDEX idx_erp_cashflow_lines_customer_date ON erp_cashflow_lines (erp_customer_id, cashflow_date DESC);
