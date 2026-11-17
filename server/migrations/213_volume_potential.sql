-- Customer volume potential (owner, 2026-11-17: "Customer Potential", one combined «Պոտենցիալ» card with the prospect level): the workshop
-- profile, the services it does, and its monthly potential per product line, to compare with what it buys from us (phase 2) and show the
-- gap in litres. The TOTAL monthly potential is customers.expected_volume_l (the existing "whole monthly need": one number, owner's answer),
-- so the funnel and this card always agree.

-- The product lines (admin-editable catalogue, not hard-coded). unit 'L' or 'kg' (grease). castrol_hint = the Castrol range shown as a hint.
CREATE TABLE IF NOT EXISTS volume_potential_lines (
  id           SERIAL PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  group_key    TEXT NOT NULL,
  name_en      TEXT NOT NULL,
  name_hy      TEXT NOT NULL,
  unit         TEXT NOT NULL DEFAULT 'L' CHECK (unit IN ('L', 'kg')),
  castrol_hint TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT true,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO volume_potential_lines (code, group_key, name_en, name_hy, unit, castrol_hint, sort_order) VALUES
  ('pcmo_0w16', 'pcmo', 'PCMO 0W-16', 'Մարդատար շարժիչի յուղ 0W-16', 'L', 'EDGE / MAGNATEC', 10),
  ('pcmo_0w20', 'pcmo', 'PCMO 0W-20', 'Մարդատար շարժիչի յուղ 0W-20', 'L', 'EDGE / MAGNATEC', 20),
  ('pcmo_0w30', 'pcmo', 'PCMO 0W-30', 'Մարդատար շարժիչի յուղ 0W-30', 'L', 'EDGE / MAGNATEC', 30),
  ('pcmo_5w30', 'pcmo', 'PCMO 5W-30', 'Մարդատար շարժիչի յուղ 5W-30', 'L', 'EDGE / MAGNATEC', 40),
  ('pcmo_5w40', 'pcmo', 'PCMO 5W-40', 'Մարդատար շարժիչի յուղ 5W-40', 'L', 'EDGE / MAGNATEC', 50),
  ('pcmo_10w40', 'pcmo', 'PCMO 10W-40', 'Մարդատար շարժիչի յուղ 10W-40', 'L', 'MAGNATEC / GTX', 60),
  ('pcmo_15w40', 'pcmo', 'PCMO 15W-40', 'Մարդատար շարժիչի յուղ 15W-40', 'L', 'GTX', 70),
  ('hdeo_10w40', 'hdeo', 'HDEO 10W-40', 'Ծանր տեխնիկայի յուղ 10W-40', 'L', 'VECTON / CRB', 80),
  ('hdeo_15w40', 'hdeo', 'HDEO 15W-40', 'Ծանր տեխնիկայի յուղ 15W-40', 'L', 'VECTON / CRB', 90),
  ('atf', 'transmission', 'ATF', 'ATF (ավտոմատ փոխանցման տուփ)', 'L', 'Transmax', 100),
  ('cvt', 'transmission', 'CVT fluid', 'CVT հեղուկ', 'L', 'Transmax', 110),
  ('dct', 'transmission', 'DCT fluid', 'DCT հեղուկ', 'L', 'Transmax', 120),
  ('gear', 'transmission', 'Manual gear oil (75W-90, 80W-90)', 'Մեխանիկական տուփի յուղ (75W-90, 80W-90)', 'L', 'Transmax', 130),
  ('ev_transmission', 'ev', 'EV transmission fluid', 'EV փոխանցման հեղուկ', 'L', 'Castrol ON', 140),
  ('ev_thermal', 'ev', 'EV thermal fluid', 'EV ջերմային հեղուկ', 'L', 'Castrol ON', 150),
  ('coolant', 'coolant', 'Antifreeze / coolant', 'Հակասառիչ', 'L', 'Radicool', 160),
  ('brake', 'brake', 'Brake fluid', 'Արգելակային հեղուկ', 'L', 'Castrol Brake Fluid', 170),
  ('grease', 'grease', 'Grease', 'Քսուք', 'kg', 'Castrol grease', 180)
ON CONFLICT (code) DO NOTHING;

-- The workshop profile and its services, one row per customer (matched by the customer id, never a name).
-- services: { "<service key>": { "does": true|false, "buys": true|false|null, "machine": true|false|null } }
CREATE TABLE IF NOT EXISTS volume_potential_profiles (
  customer_id    INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  cars_per_month INTEGER CHECK (cars_per_month IS NULL OR cars_per_month BETWEEN 0 AND 100000),
  bays           INTEGER CHECK (bays IS NULL OR bays BETWEEN 0 AND 1000),
  vehicle_mix    TEXT[] NOT NULL DEFAULT '{}',
  brands         TEXT[] NOT NULL DEFAULT '{}',
  brands_other   TEXT,
  services       JSONB NOT NULL DEFAULT '{}'::jsonb,
  source         TEXT CHECK (source IS NULL OR source IN ('rep_estimate', 'customer_stated', 'invoice')),
  confidence     TEXT CHECK (confidence IS NULL OR confidence IN ('low', 'med', 'high')),
  updated_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Its monthly potential per product line (litres; kg for grease) and an optional estimate of our share.
CREATE TABLE IF NOT EXISTS volume_potential_amounts (
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  line_id       INTEGER NOT NULL REFERENCES volume_potential_lines(id) ON DELETE CASCADE,
  amount_month  NUMERIC(10, 1) NOT NULL CHECK (amount_month >= 0 AND amount_month <= 1000000),
  our_share_pct INTEGER CHECK (our_share_pct IS NULL OR our_share_pct BETWEEN 0 AND 100),
  PRIMARY KEY (customer_id, line_id)
);

-- Every save, before and after (the profile, the lines and the total), so a change can be traced.
CREATE TABLE IF NOT EXISTS volume_potential_history (
  id          SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  changed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  before      JSONB,
  after       JSONB NOT NULL,
  -- a save sent again from the phone's offline queue (same client_ref) is not saved twice
  client_ref  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS volume_potential_history_client_ref_idx ON volume_potential_history (client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS volume_potential_history_customer_idx ON volume_potential_history (customer_id, changed_at DESC);
