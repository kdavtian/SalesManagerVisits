-- Foundations for the production-grade Products & Pricelist module:
-- a real "retail" price distinct from the trade/standard price, a
-- singleton company profile for pricelist headers/branding, a phone
-- field so a rep's "Prepared by" footer can carry a contact number, and
-- a price-change history table so every standard/retail/special price
-- edit is traceable (who, when, before/after) instead of silently
-- overwritten.

-- retail_price_amd defaults to the existing unit_price_amd (today's de
-- facto "customer-facing" price) so nothing regresses until someone
-- explicitly sets a different retail price.
ALTER TABLE products ADD COLUMN retail_price_amd NUMERIC;
UPDATE products SET retail_price_amd = unit_price_amd WHERE retail_price_amd IS NULL;

ALTER TABLE users ADD COLUMN phone TEXT;

-- Singleton row (id is pinned to 1 via the CHECK) -- one company, one
-- profile, editable by admin/ceo/accountant instead of being hardcoded
-- into the pricelist template.
CREATE TABLE company_profile (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'KAD Motors',
  phone TEXT,
  email TEXT,
  website TEXT,
  address TEXT,
  logo_path TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO company_profile (id, name) VALUES (1, 'KAD Motors');

-- One row per price change. A 'special' row with old_value NULL is the
-- promo being created; one with new_value NULL is it being cancelled/
-- deleted early. This is intentionally append-only -- nothing here is
-- ever updated or deleted, so "what price did this product have on
-- Sep 15" is always answerable.
CREATE TABLE product_price_history (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price_type TEXT NOT NULL CHECK (price_type IN ('standard', 'retail', 'special')),
  old_value NUMERIC,
  new_value NUMERIC,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT
);
CREATE INDEX product_price_history_product_id_idx ON product_price_history (product_id, changed_at DESC);
