-- Frontend error monitoring (improvement list area 7.5): there was no
-- visibility into client-side JS errors or slow page loads at all before
-- this -- they only ever showed up if a user happened to mention them.
-- Same shape/intent as notification_delivery_log (072): an admin-visible
-- log, not a full APM pipeline.
CREATE TABLE client_error_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('error', 'unhandledrejection', 'slow_load')),
  message TEXT NOT NULL,
  stack TEXT,
  url TEXT,
  duration_ms INTEGER,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX client_error_log_created_at_idx ON client_error_log (created_at DESC);
