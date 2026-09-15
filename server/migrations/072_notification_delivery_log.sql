-- Every web-push delivery attempt (one row per subscription per attempt),
-- previously only ever console.log'd/console.error'd and then forgotten --
-- nothing recorded whether a push actually reached a device, and a
-- transient failure (a momentary network blip to the push service, as
-- opposed to a permanently expired subscription) was just dropped with no
-- retry at all. See src/push.js.
CREATE TABLE notification_delivery_log (
  id SERIAL PRIMARY KEY,
  notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'expired')),
  status_code INTEGER,
  error_message TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notification_delivery_log_notification_id_idx ON notification_delivery_log (notification_id);
CREATE INDEX notification_delivery_log_attempted_at_idx ON notification_delivery_log (attempted_at DESC);
