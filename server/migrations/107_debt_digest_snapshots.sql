-- One row per weekly debt digest (Monday): the company's debt picture at that moment, so the
-- next digest can say what changed since last week (total, overdue, biggest movers).
CREATE TABLE debt_digest_snapshots (
  snapshot_date  DATE PRIMARY KEY,
  total_debt_amd NUMERIC(16, 2) NOT NULL,
  overdue_amd    NUMERIC(16, 2) NOT NULL,
  by_bucket      JSONB NOT NULL,
  -- { "<customer id>": { "name": "...", "debt": 123, "overdue": 45 } } for every customer with debt
  customers      JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
