-- Sales Expert (owner, 2026-11-15): the rep writes a customer's whole monthly oil need (all brands, litres) at the visit, once and again every
-- 3 months; the funnel measures our share of it (stage 4). When and by whom it was last written, so the check-in knows when to ask again.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS expected_volume_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS expected_volume_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
-- an existing number counts as written now (it may have been typed on the funnel screen last week): reps are asked again in 3 months
UPDATE customers SET expected_volume_at = now() WHERE expected_volume_l IS NOT NULL AND expected_volume_at IS NULL;
