-- Fuel allowance for sales reps' cars: per-rep consumption + home address,
-- a fuel price per month, optional per-day km corrections and a cache of
-- road distances (so a month's report does not re-ask the routing engine).
ALTER TABLE users ADD COLUMN IF NOT EXISTS fuel_l_per_100km NUMERIC(5, 2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lat DOUBLE PRECISION;
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lng DOUBLE PRECISION;

CREATE TABLE IF NOT EXISTS fuel_prices (
  month DATE PRIMARY KEY, -- first day of the month
  price_amd_per_l NUMERIC(8, 2) NOT NULL CHECK (price_amd_per_l > 0),
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fuel_day_overrides (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  km NUMERIC(7, 1) NOT NULL CHECK (km >= 0),
  note TEXT,
  set_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS fuel_route_cache (
  key TEXT PRIMARY KEY, -- sha1 of the rounded waypoint list
  leg_km JSONB NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
