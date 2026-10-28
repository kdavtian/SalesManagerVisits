-- One scheduler for the background jobs (docs/architecture-roadmap.md, step 4; server/src/jobs/). One row per job: when it runs next
-- (a job is claimed by moving next_run_at forward in one UPDATE, so two server copies never run it twice) and how its last run went
-- (shown to the admin in Settings > System health).
CREATE TABLE IF NOT EXISTS background_jobs (
  name TEXT PRIMARY KEY,
  every_seconds INTEGER NOT NULL CHECK (every_seconds > 0),
  next_run_at TIMESTAMPTZ NOT NULL,
  last_started_at TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ,
  last_ok BOOLEAN,
  last_error TEXT,
  last_duration_ms INTEGER,
  runs INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
);
