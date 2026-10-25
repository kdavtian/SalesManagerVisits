-- Vaghinak's expense analysis (owner, 2026-10-25): findings about spending (a category jumping, an unusually large entry, a duplicate,
-- a field cash expense that the Excel cashflow does not show) and the weekly report he sends to management.
CREATE TABLE expense_alerts (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  severity INTEGER NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
  category TEXT,
  amount_amd NUMERIC,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'auto_resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX expense_alerts_dedupe_idx ON expense_alerts (dedupe_key);
CREATE INDEX expense_alerts_status_idx ON expense_alerts (status, created_at DESC);

CREATE TABLE expense_reports (
  id SERIAL PRIMARY KEY,
  week_start DATE NOT NULL UNIQUE,
  summary JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
