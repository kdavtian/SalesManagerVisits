-- Sales Expert (owner, 2026-11-15): the rep writes a customer's whole monthly oil need (all brands, litres) at the visit, once and again every
-- 3 months; the funnel measures our share of it (stage 4). When and by whom it was last written, so the check-in knows when to ask again.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS expected_volume_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS expected_volume_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
UPDATE customers SET expected_volume_at = COALESCE(potential_updated_at, created_at) WHERE expected_volume_l IS NOT NULL AND expected_volume_at IS NULL;
