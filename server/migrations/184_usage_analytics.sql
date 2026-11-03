-- Usage analytics (owner, 2026-11-03: "count which pages are most visited and how much time is spent there ... give a switch in the admin settings").
-- OFF by default. When the admin turns it on, the app sends which screens people open (the address without ids or search text), how long each was in
-- front of them and which menu / tab buttons they tap. No customer, amount or text is ever stored. Rows older than 90 days are deleted by a job.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS usage_analytics_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS usage_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  role TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('page', 'tap')),
  target TEXT NOT NULL,
  seconds INTEGER,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_at_idx ON usage_events (at);
CREATE INDEX IF NOT EXISTS usage_events_kind_target_idx ON usage_events (kind, target, at);
