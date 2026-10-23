-- Staff module (owner, 2026-10-23): people, who reports to whom, pay rules, working-day marks and pay items. Replaces the Excel sheets
-- Tabel / Sales Team_2026 / Plan_2026. Everything is set in the module; Cashflow "Salary" rows are the payments.

ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS staff_settings JSONB;

CREATE TABLE staff_members (
  id                          SERIAL PRIMARY KEY,
  user_id                     INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,   -- the person's login, when there is one
  name                        TEXT NOT NULL,
  position                    TEXT NOT NULL,                                            -- title; also what Cashflow salary rows are matched on ("<position> 2026 OCT")
  pay_keys                    TEXT[] NOT NULL DEFAULT '{}',                             -- other spellings of the position in Cashflow (SM YVN = Sales Manager YVN)
  kind                        TEXT NOT NULL DEFAULT 'office' CHECK (kind IN ('executive', 'director', 'rep', 'office', 'warehouse', 'driver')),
  reports_to                  INTEGER REFERENCES staff_members(id) ON DELETE SET NULL,
  channel                     TEXT,                                                     -- the sales channel of a rep (SM YVN ...)
  fixed_salary_amd            NUMERIC(14, 2) NOT NULL DEFAULT 0,                        -- per month, split over the month's working days
  visit_based                 BOOLEAN NOT NULL DEFAULT false,                           -- a day pays only when enough PLANNED visits were done
  min_visit_pct               INTEGER CHECK (min_visit_pct BETWEEN 1 AND 100),          -- this person's threshold; NULL = the company default
  paid_dayoffs_per_month      INTEGER NOT NULL DEFAULT 0 CHECK (paid_dayoffs_per_month BETWEEN 0 AND 31),
  commission_basis            TEXT NOT NULL DEFAULT 'none' CHECK (commission_basis IN ('none', 'collected', 'sales')),
  commission_pct              NUMERIC(5, 2) NOT NULL DEFAULT 0,
  commission_channels         TEXT[],                                                   -- NULL = every channel
  commission_excluded         TEXT[] NOT NULL DEFAULT '{}',                             -- channels that never count (KF, CAS for the sales director)
  start_date                  DATE,
  end_date                    DATE,
  active                      BOOLEAN NOT NULL DEFAULT true,
  note                        TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reports_to IS NULL OR reports_to <> id)
);
CREATE INDEX staff_members_reports_to_idx ON staff_members (reports_to);

-- A day's explicit mark. No mark = the automatic rule (visit-based: planned visits done; others: a normal working day).
--   completed = counts as a full day whatever the visits were; dayoff = a day off (paid up to the person's allowance); unpaid = not paid.
CREATE TABLE staff_days (
  staff_id    INTEGER NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('completed', 'dayoff', 'unpaid')),
  note        TEXT,
  marked_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  marked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (staff_id, day)
);

-- Premiums, bonuses and deductions of a month.
CREATE TABLE staff_pay_items (
  id          SERIAL PRIMARY KEY,
  staff_id    INTEGER NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
  month       DATE NOT NULL,                       -- the first day of the month it belongs to
  kind        TEXT NOT NULL CHECK (kind IN ('premium', 'bonus', 'deduction')),
  amount_amd  NUMERIC(14, 2) NOT NULL CHECK (amount_amd > 0),
  note        TEXT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX staff_pay_items_month_idx ON staff_pay_items (staff_id, month);
