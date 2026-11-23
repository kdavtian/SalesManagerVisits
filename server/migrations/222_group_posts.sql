-- Messages the app wants posted to the accounting Telegram group (owner, 2026-11-23: "when sales director approves an order, send the
-- details to the accountants' Telegram group so they see it immediately and know what to put in the waybill or invoice").
-- The app writes the text here; the CEO bot asks for what is waiting (GET /api/erp-sync/group-posts/pending), posts it to the same group
-- as the daily cash sheets and reports back. A post that keeps failing stops being offered after 10 tries.
CREATE TABLE IF NOT EXISTS group_posts (
  id              SERIAL PRIMARY KEY,
  kind            TEXT NOT NULL,                 -- 'order_confirmed' | 'order_unconfirmed' | 'order_cancelled' (new kinds need no bot change)
  ref_id          INTEGER,                       -- the order (no foreign key: a deleted order still gets its "cancelled" message)
  title           TEXT,                          -- "code · customer", for a message about an order that no longer exists
  text            TEXT NOT NULL,                 -- frozen when written: what was confirmed, not what the order looks like later
  content_hash    TEXT,                          -- of the details: has the order changed since the group was told?
  claimed_at      TIMESTAMPTZ,                   -- the bot took it (from then on it is never edited in place)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_at       TIMESTAMPTZ,
  post_attempts   INTEGER NOT NULL DEFAULT 0,
  last_post_error TEXT
);
CREATE INDEX IF NOT EXISTS group_posts_waiting_idx ON group_posts (id) WHERE posted_at IS NULL;
CREATE INDEX IF NOT EXISTS group_posts_ref_idx ON group_posts (ref_id, id);

-- On / Off in App configuration (ON by default: the owner asked for it).
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS order_confirm_telegram BOOLEAN NOT NULL DEFAULT true;
-- Only orders confirmed since the switch was (last) turned on are announced: no flood of old orders on the first deploy.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS order_confirm_telegram_since TIMESTAMPTZ NOT NULL DEFAULT now();
-- The job "order-group-posts" reads the orders changed in the last two days every minute.
CREATE INDEX IF NOT EXISTS orders_updated_at_idx ON orders (updated_at);
