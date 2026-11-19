-- Viscosity and competitor prices (owner, 2026-11-19): "detailed database to later do market analysis".
--
-- 1. products.viscosity ("5W-30"): filled from the product name by the database itself (every writer -- the Excel sync, the product
--    import, the Products form -- gets it), unless management typed it by hand (viscosity_manual). Additive; backfilled.
-- 2. competitor_prices: the prices a rep writes at a check-in for a competitor brand's product line (the Potential product lines, e.g.
--    "PCMO 5W-30"), per volume: wholesale (what the shop pays its supplier) and retail (shelf price), AMD. One row per visit, brand,
--    line and volume, so history and trends stay.
ALTER TABLE products ADD COLUMN IF NOT EXISTS viscosity TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS viscosity_manual BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION viscosity_of_name(name TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  -- "05W-30" is 5W-30 (a leading zero dropped; "0W-20" keeps its zero)
  SELECT regexp_replace(upper(regexp_replace(substring(name from '(?i)(\d{1,2}\s*w\s*-?\s*\d{1,3})'), '\s*[Ww]\s*-?\s*', 'W-')), '^0([0-9])W', '\1W')
$$;

CREATE OR REPLACE FUNCTION products_fill_viscosity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.viscosity_manual THEN
    NEW.viscosity := viscosity_of_name(NEW.name);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS products_fill_viscosity ON products;
CREATE TRIGGER products_fill_viscosity BEFORE INSERT OR UPDATE OF name, viscosity, viscosity_manual ON products
  FOR EACH ROW EXECUTE FUNCTION products_fill_viscosity();

UPDATE products SET viscosity = viscosity_of_name(name) WHERE NOT viscosity_manual;

CREATE TABLE IF NOT EXISTS competitor_prices (
  id            SERIAL PRIMARY KEY,
  checkin_id    INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  brand_key     TEXT NOT NULL,                 -- competitor_brands.key
  line_code     TEXT NOT NULL,                 -- volume_potential_lines.code
  volume        NUMERIC(8,3) NOT NULL CHECK (volume > 0),
  unit          TEXT NOT NULL DEFAULT 'L' CHECK (unit IN ('L', 'kg')),
  wholesale_amd INTEGER CHECK (wholesale_amd IS NULL OR wholesale_amd >= 0),
  retail_amd    INTEGER CHECK (retail_amd IS NULL OR retail_amd >= 0),
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (wholesale_amd IS NOT NULL OR retail_amd IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS competitor_prices_latest_idx ON competitor_prices (brand_key, line_code, volume, recorded_at DESC);
CREATE INDEX IF NOT EXISTS competitor_prices_checkin_idx ON competitor_prices (checkin_id);
