-- Vaghinak - Sales Expert, step 3 (owner, 2026-11-15): the weekly AI market strategy (team/vaghinak/strategist.js). One report per week
-- (a regenerate replaces it); the token counts and the estimated cost of every run are kept so the cost is visible.
CREATE TABLE IF NOT EXISTS sales_strategy_reports (
  id            SERIAL PRIMARY KEY,
  week_start    DATE NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(10, 4) NOT NULL DEFAULT 0,
  masked_names  INTEGER NOT NULL DEFAULT 0,
  report        JSONB NOT NULL
);
