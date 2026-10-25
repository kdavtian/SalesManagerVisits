-- Region / subregion spelling (owner, 2026-10-25): the free text typed on a customer is matched against the built-in list of Armenian places
-- (server/src/places.js). What matches is saved with the right English name (shown in Armenian when the app is in Armenian). What does not match
-- is kept as typed and lands here for a person to look at; one-letter corrections are logged too.
CREATE TABLE place_reviews (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  field TEXT NOT NULL CHECK (field IN ('region', 'subregion')),
  typed_value TEXT NOT NULL,
  applied_value TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('unknown', 'corrected', 'other_region')),
  suggestions JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  resolution TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolved_at TIMESTAMPTZ
);
-- one open review per customer field: a newer edit replaces the older one
CREATE UNIQUE INDEX place_reviews_one_pending ON place_reviews (customer_id, field) WHERE status = 'pending';
CREATE INDEX place_reviews_status_idx ON place_reviews (status, created_at DESC);

-- places an admin approved ("keep as typed"): they are matched like the built-in ones from then on
CREATE TABLE custom_places (
  id SERIAL PRIMARY KEY,
  name_en TEXT NOT NULL,
  name_hy TEXT,
  region TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX custom_places_name_idx ON custom_places (lower(name_en), COALESCE(region, ''));
