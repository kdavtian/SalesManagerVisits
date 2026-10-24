-- One row per call of the Excel / ERP sync endpoints that FAILED, or that succeeded but had to skip an optional step (2026-10-24).
-- Until now a rejected sync left no trace on this side: only the bot's own journal knew. Kept 30 days.
CREATE TABLE IF NOT EXISTS erp_sync_attempts (
  id        BIGSERIAL PRIMARY KEY,
  endpoint  TEXT NOT NULL,
  ok        BOOLEAN NOT NULL,
  error     TEXT,
  warnings  TEXT[] NOT NULL DEFAULT '{}',
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS erp_sync_attempts_at_idx ON erp_sync_attempts (at DESC);
