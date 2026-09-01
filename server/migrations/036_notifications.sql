-- In-app notification inbox. Until now every notification.js/push.js trigger
-- only ever fired a Web Push (which the user's device may have dropped,
-- muted, or simply not be subscribed to) -- there was nowhere in the app
-- itself to look back at what happened. This table is the record of truth
-- each user's Notifications page reads from; push stays a best-effort nudge
-- on top of it, not the only copy.
CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The Notifications page always queries "this user, newest first"; read/
-- unread is a filter on top of that same ordering, not a separate query
-- shape, so one index covers both the full list and the unread badge count.
CREATE INDEX idx_notifications_user_created ON notifications (user_id, created_at DESC);
