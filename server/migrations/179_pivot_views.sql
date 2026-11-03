-- Saved setups of the Pivot report (owner, 2026-11-03: "save + share"): the data source, fields, filters and layout under a name.
-- Private to the person who saved it, or shared with everyone who may open the Pivot report (admin and CEO).
CREATE TABLE IF NOT EXISTS pivot_views (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  config JSONB NOT NULL,
  shared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pivot_views_owner_idx ON pivot_views (owner_id);
