-- Vaghinak - Sales Expert, step 1 (owner, 2026-11-15): the sales funnel (server/src/team/vaghinak/funnel.js). Where each customer stands now
-- (one row per customer, since when) and every move between stages, so the Funnel screen shows this month's movement and who is stuck.
CREATE TABLE IF NOT EXISTS customer_funnel_stage (
  customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  stage       SMALLINT NOT NULL CHECK (stage BETWEEN 1 AND 4),
  since       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_funnel_moves (
  id          SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  from_stage  SMALLINT NOT NULL,
  to_stage    SMALLINT NOT NULL,
  moved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_funnel_moves_at_idx ON customer_funnel_moves (moved_at);
