-- Push-notification preferences, adjustable per role (admin-configured
-- defaults) and per individual user (self-service override). A row with
-- scope_type='user' always wins over a scope_type='role' row for the same
-- notification_type; with no row at all for a (user, type) pair, the
-- notification is enabled by default.
CREATE TABLE notification_settings (
  id SERIAL PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('role', 'user')),
  scope_value TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_value, notification_type)
);
