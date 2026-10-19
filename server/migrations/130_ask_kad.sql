-- "Ask KAD": the admin asks questions about the company's own data and a Claude model answers
-- (server/src/askKad). Two App-configuration settings and a log of every request: what was sent
-- (customer and staff names are replaced by codes before anything leaves the server), which data tools
-- ran, token counts and the cost, so the monthly spending cap can be enforced and audited.
ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS ask_kad_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS ask_kad_monthly_cap_usd NUMERIC(8, 2) NOT NULL DEFAULT 20;

CREATE TABLE IF NOT EXISTS ask_kad_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  question_masked TEXT NOT NULL,
  masked_names INTEGER NOT NULL DEFAULT 0,
  tools TEXT[] NOT NULL DEFAULT '{}',
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 4) NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ask_kad_log_created ON ask_kad_log (created_at);
