-- Recurring visit-cycle rules ("every Monday, visit Ajapnyak + Davtashen
-- subregions"), kept separate from the one-off visit_plans table.
-- Deliberately NOT materialized into visit_plans rows: the customer list
-- for a rule is expanded from the *current* customers table at read time,
-- so adding/removing a customer from a region is reflected immediately
-- without ever going stale. A one-off visit_plans row for a given date
-- always takes priority over a rule for that weekday (manual override).
CREATE TABLE visit_plan_rules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  areas JSONB NOT NULL DEFAULT '[]',
  created_by INTEGER NOT NULL REFERENCES users(id),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, day_of_week)
);
