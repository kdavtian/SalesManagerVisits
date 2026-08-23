-- Full line-item order history per ERP customer, for the "show all orders"
-- drill-down. The customer detail page's inline preview only shows the
-- last 3 months (query-side filter); "show all" removes that filter.
-- Replaced wholesale on every sync, same as erp_customer_data.
CREATE TABLE erp_order_lines (
  id                SERIAL PRIMARY KEY,
  erp_customer_id   TEXT NOT NULL,
  order_id          TEXT NOT NULL,
  order_date        DATE NOT NULL,
  product_id        TEXT,
  brand             TEXT,
  product_name      TEXT,
  size_l            TEXT,
  qty               NUMERIC,
  unit_price_amd    NUMERIC,
  revenue_amd       NUMERIC
);

CREATE INDEX idx_erp_order_lines_customer_date ON erp_order_lines (erp_customer_id, order_date DESC);
CREATE INDEX idx_erp_order_lines_customer_order ON erp_order_lines (erp_customer_id, order_id);
