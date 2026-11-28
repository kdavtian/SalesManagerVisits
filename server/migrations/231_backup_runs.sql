-- One row per run of deploy/backup.sh (written by the script itself, through psql on the droplet). Settings > System health
-- shows "Last good backup" from it and turns red when the newest good one is older than 36 hours (system/backupStatus.js).
CREATE TABLE IF NOT EXISTS backup_runs (
  id            BIGSERIAL PRIMARY KEY,
  finished_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok            BOOLEAN NOT NULL,
  db_bytes      BIGINT,
  uploads_bytes BIGINT,
  offsite       TEXT,          -- where the off-server copy went ('spaces', 'telegram', ...); NULL = local only
  detail        TEXT           -- the failed step, or a warning on a good run
);
CREATE INDEX IF NOT EXISTS backup_runs_ok_finished_idx ON backup_runs (ok, finished_at DESC);
