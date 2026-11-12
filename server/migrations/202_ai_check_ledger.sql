-- Vaghinak's document check (owner, 2026-11-12), review fixes:
--  * every model call's cost goes to its own ledger row, so the monthly cap counts it even when a re-check, a turned photo or a failure later
--    replaces the document's verdict (customer_files.ai_result was the only record before);
--  * a failed check counts its attempts, so one broken photo is tried a few times and then left alone instead of blocking the round.
CREATE TABLE IF NOT EXISTS ai_check_spend (
  id SERIAL PRIMARY KEY,
  file_id INTEGER REFERENCES customer_files(id) ON DELETE SET NULL,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  spent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_check_spend_at_idx ON ai_check_spend (spent_at);
-- what this month already cost before the ledger existed
INSERT INTO ai_check_spend (file_id, cost_usd, spent_at)
SELECT id, (ai_result->>'cost_usd')::numeric, ai_checked_at FROM customer_files
WHERE ai_checked_at >= date_trunc('month', now()) AND jsonb_typeof(ai_result->'cost_usd') = 'number';

ALTER TABLE customer_files ADD COLUMN IF NOT EXISTS ai_attempts INTEGER NOT NULL DEFAULT 0;
