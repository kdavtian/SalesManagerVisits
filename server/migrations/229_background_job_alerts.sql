-- A background job that keeps failing or hangs is reported (improvement plan 0.22, server/src/jobs/scheduler.js): failures in a row since
-- the last good run, and when the admin chat was last told about this job (at most once a day per job).
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS failures_in_a_row INTEGER NOT NULL DEFAULT 0;
ALTER TABLE background_jobs ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ;
