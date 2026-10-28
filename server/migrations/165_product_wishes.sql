-- Wished products (owner, 2026-10-28): an order may hold only what is on the shelf; what a customer wants but we do not have
-- (out of stock, or a product we never carried) is written down here, so the assortment can follow demand.
-- product_id = a catalog product that was out of stock; custom_name = a product we do not have at all.
-- back_in_stock_at: set once the wished product is available again and the rep (and the KAD OS customer) were told.
CREATE TABLE IF NOT EXISTS product_wishes (
  id               SERIAL PRIMARY KEY,
  customer_id      INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
  custom_name      TEXT,
  quantity         INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  note             TEXT,
  source           TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'kados')),
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  back_in_stock_at TIMESTAMPTZ,
  CHECK (product_id IS NOT NULL OR length(trim(coalesce(custom_name, ''))) > 0)
);
CREATE INDEX IF NOT EXISTS product_wishes_waiting_idx ON product_wishes (product_id) WHERE back_in_stock_at IS NULL;
CREATE INDEX IF NOT EXISTS product_wishes_created_idx ON product_wishes (created_at);
CREATE INDEX IF NOT EXISTS product_wishes_customer_idx ON product_wishes (customer_id);
