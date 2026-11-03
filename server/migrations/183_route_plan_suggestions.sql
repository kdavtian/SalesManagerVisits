-- Vaghinak's route-plan analysis (owner, 2026-11-03): suggestions for the reps' recurring route plans. NOTHING changes in a plan until the CEO (or admin)
-- accepts a suggestion, one by one or all at once; every decision is kept here as the log (who, when, what).
CREATE TABLE IF NOT EXISTS route_plan_suggestions (
  id SERIAL PRIMARY KEY,
  rep_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('move', 'add')),
  from_dow SMALLINT CHECK (from_dow BETWEEN 0 AND 6),
  to_dow SMALLINT NOT NULL CHECK (to_dow BETWEEN 0 AND 6),
  reason JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed', 'stale')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS route_plan_suggestions_status_idx ON route_plan_suggestions (status, rep_id);
