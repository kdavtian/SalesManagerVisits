-- Admin-managed mapping from Region/Subregion to a default Sales Channel and
-- Sales Manager, used to auto-assign new customers created from a detected
-- location. subregion NULL means "applies to the whole region" (a fallback
-- when no subregion-specific row exists).
CREATE TABLE route_distribution (
  id SERIAL PRIMARY KEY,
  region TEXT NOT NULL,
  subregion TEXT,
  sales_channel TEXT NOT NULL,
  assigned_manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Treats NULL subregion as its own distinct value for uniqueness (Postgres
-- normally lets multiple NULLs through a plain UNIQUE constraint).
CREATE UNIQUE INDEX route_distribution_region_subregion_idx
  ON route_distribution (region, COALESCE(subregion, ''));
