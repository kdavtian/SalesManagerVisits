-- Excel sync status and the admin "Sync now" button (owner, 2026-10-24).
-- erp_sync_runs: one row per successful main sync (counts, skipped steps, and the date of the Excel file the bot used), so the app can say
-- "last sync 17:05, Excel file from 20 Oct (4 days old)". Failed calls stay in erp_sync_attempts. Kept 60 days.
CREATE TABLE IF NOT EXISTS erp_sync_runs (
  id                   BIGSERIAL PRIMARY KEY,
  at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  counts               JSONB NOT NULL DEFAULT '{}',
  warnings             TEXT[] NOT NULL DEFAULT '{}',
  workbook_modified_at TIMESTAMPTZ,
  workbook_name        TEXT,
  request_id           BIGINT
);
CREATE INDEX IF NOT EXISTS erp_sync_runs_at_idx ON erp_sync_runs (at DESC);

-- erp_sync_requests: "Sync now" asks the bot (on the droplet, where the Excel file is) to push the workbook it holds again.
-- The bot polls for an open request every 30 s with the sync key, runs the sync and reports the result here.
CREATE TABLE IF NOT EXISTS erp_sync_requests (
  id           BIGSERIAL PRIMARY KEY,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_at    TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  ok           BOOLEAN,
  message      TEXT
);
CREATE INDEX IF NOT EXISTS erp_sync_requests_at_idx ON erp_sync_requests (requested_at DESC);
