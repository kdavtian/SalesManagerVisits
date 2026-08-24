-- Web Push subscriptions, one row per browser/device a user has enabled
-- notifications on (a rep could have this on both their phone's home-screen
-- PWA and a desktop browser). The endpoint URL itself is the natural unique
-- key -- the same subscription payload always carries the same endpoint.
CREATE TABLE push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_push_subscriptions_user ON push_subscriptions (user_id);
