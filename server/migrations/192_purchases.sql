-- Purchases (owner, 2026-11-07: "add new module Purchases, it should replace Purchase_IN in Excel"; side-by-side first). Supplier invoices
-- are typed in the app with the columns of the Excel Purchase_IN sheet; the bot also sends Purchase_IN rows (erp_purchase_lines) so every
-- invoice can be compared app <-> Excel. Excel stays the source for stock until the owner switches the module over.
CREATE TABLE IF NOT EXISTS suppliers (
  id serial PRIMARY KEY,
  name text NOT NULL,
  brands text,
  note text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_key ON suppliers (lower(name));

CREATE TABLE IF NOT EXISTS purchase_invoices (
  id serial PRIMARY KEY,
  invoice_no text NOT NULL,
  invoice_date date NOT NULL,
  supplier_id integer NOT NULL REFERENCES suppliers(id),
  usd_rate numeric(10, 4) NOT NULL CHECK (usd_rate > 0),
  note text,
  client_ref text UNIQUE,
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_invoices_date_idx ON purchase_invoices (invoice_date DESC);

CREATE TABLE IF NOT EXISTS purchase_lines (
  id serial PRIMARY KEY,
  invoice_id integer NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  product_id integer REFERENCES products(id) ON DELETE SET NULL,
  product_name text NOT NULL,
  brand text,
  size_l numeric(10, 3),
  qty numeric(12, 3) NOT NULL CHECK (qty > 0),
  cost_usd numeric(12, 4) NOT NULL CHECK (cost_usd >= 0)
);
CREATE INDEX IF NOT EXISTS purchase_lines_invoice_idx ON purchase_lines (invoice_id);

-- the Excel Purchase_IN sheet as the bot last sent it (replaced on every push)
CREATE TABLE IF NOT EXISTS erp_purchase_lines (
  id serial PRIMARY KEY,
  invoice_no text NOT NULL,
  invoice_date date NOT NULL,
  supplier text,
  erp_product_id text,
  brand text,
  product_name text,
  size_l numeric(10, 3),
  qty numeric(12, 3),
  cost_usd numeric(12, 4),
  amount_amd numeric(16, 2),
  info text,
  excel_row integer,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS erp_purchase_lines_invoice_idx ON erp_purchase_lines (invoice_date, invoice_no);
