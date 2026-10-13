-- Route plan SETS: several complete route plans (every rep x weekday -> ordered customers, plus the visit
-- frequency of those customers) that can be created automatically, rearranged, duplicated and switched.
-- Exactly one set is "active": activating it copies its rules into visit_plan_rules (what the rest of the app
-- reads) and its frequencies into customers.visit_frequency_days.
CREATE TABLE route_plan_sets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('auto', 'manual', 'snapshot')),
  params JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT false,
  activated_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX route_plan_sets_one_active ON route_plan_sets ((true)) WHERE is_active;

-- customer_ids is ORDERED: the order is the suggested visiting order of that day.
CREATE TABLE route_plan_set_rules (
  set_id INTEGER NOT NULL REFERENCES route_plan_sets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  customer_ids INTEGER[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (set_id, user_id, day_of_week)
);

CREATE TABLE route_plan_set_frequencies (
  set_id INTEGER NOT NULL REFERENCES route_plan_sets(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  days SMALLINT NOT NULL CHECK (days BETWEEN 1 AND 365),
  PRIMARY KEY (set_id, customer_id)
);
