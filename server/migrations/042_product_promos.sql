-- Date-ranged promotional pricing (item 6 of the CEO's feature list): an
-- admin sets a "special period" price on a product that only applies while
-- today falls within [starts_on, ends_on] -- the pricelist page picks up
-- and drops the promo automatically as those dates roll by, with no manual
-- on/off toggle to forget about.
CREATE TABLE product_promos (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  promo_price_amd NUMERIC NOT NULL,
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);

CREATE INDEX product_promos_product_id_idx ON product_promos (product_id);
-- Speeds up "which promos are active today" without a per-row date scan.
CREATE INDEX product_promos_active_range_idx ON product_promos (starts_on, ends_on);
