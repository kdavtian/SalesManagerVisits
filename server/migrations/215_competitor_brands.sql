-- Competitor brands of the check-in shelf (owner, 2026-11-19): the list moves from code into the database so a rep can add a brand
-- ("+ Add new brand"): it is usable at once by that rep, and admin / CEO approve it (Requests card + push) before every rep sees it.
-- A visit keeps recording the brands present in brand_status.competitors (keys), plus per brand bottles / drum / not available
-- (brand_status.competitor_packs). Additive only; the 18 brands of the code list are seeded approved, in the same order.
CREATE TABLE IF NOT EXISTS competitor_brands (
  id               SERIAL PRIMARY KEY,
  key              TEXT NOT NULL UNIQUE,              -- what a visit stores (the 18 seeded keys, or a new brand's name in lower case)
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending', 'approved', 'denied')),
  sort_order       INTEGER NOT NULL DEFAULT 999,
  requested_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at       TIMESTAMPTZ,
  decision_reason  TEXT
);
CREATE INDEX IF NOT EXISTS competitor_brands_pending_idx ON competitor_brands (status) WHERE status = 'pending';

INSERT INTO competitor_brands (key, name, status, sort_order) VALUES
  ('mobil', 'Mobil', 'approved', 10), ('motul', 'Motul', 'approved', 20), ('shell', 'Shell', 'approved', 30),
  ('liquimoly', 'LiquiMoly', 'approved', 40), ('aral', 'Aral', 'approved', 50), ('bardahl', 'Bardahl', 'approved', 60),
  ('petronas', 'Petronas', 'approved', 70), ('fuchs', 'Fuchs', 'approved', 80), ('total', 'Total', 'approved', 90),
  ('ravenol', 'Ravenol', 'approved', 100), ('oscar', 'Oscar', 'approved', 110), ('amsoil', 'AMSoil', 'approved', 120),
  ('zic', 'Zic', 'approved', 130), ('pennzoil', 'Pennzoil', 'approved', 140), ('addinol', 'Addinol', 'approved', 150),
  ('s_oil', 'S-Oil', 'approved', 160), ('kixx', 'Kixx', 'approved', 170), ('russian_oil', 'Russian oil', 'approved', 180)
ON CONFLICT (key) DO NOTHING;
