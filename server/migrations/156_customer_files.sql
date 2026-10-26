-- Customer documents (owner, 2026-10-26): signed order blanks, signed delivery-acceptance acts, payment slips. One table for all of them;
-- a file belongs to the customer and is linked to the order(s) / payment it proves, so the customer's Files, an order's Documents and the
-- accountant's inbox are three views of the same rows. Files are kept forever (until an archiving system exists).
CREATE TABLE IF NOT EXISTS customer_files (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('order_blank', 'signed_act', 'payment_slip', 'other')),
  file_path TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  size_bytes INTEGER,
  order_ids INTEGER[] NOT NULL DEFAULT '{}',
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  checkin_id INTEGER REFERENCES checkins(id) ON DELETE SET NULL,
  note TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ai_status TEXT,
  ai_result JSONB,
  ai_checked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_customer_files_customer ON customer_files (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_files_created ON customer_files (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_files_checkin ON customer_files (checkin_id) WHERE checkin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_files_orders ON customer_files USING GIN (order_ids);

-- The order blanks photographed at check-ins (migration 155) move here from checkin_photos.
INSERT INTO customer_files (customer_id, kind, file_path, mime, order_ids, checkin_id, created_by, created_at)
SELECT ch.customer_id, 'order_blank', cp.photo_path, 'image/jpeg', cp.order_ids, ch.id, ch.user_id, ch.timestamp
FROM checkin_photos cp
JOIN checkins ch ON ch.id = cp.checkin_id
WHERE cp.kind = 'order_blank';
DELETE FROM checkin_photos WHERE kind = 'order_blank';
ALTER TABLE checkin_photos DROP COLUMN IF EXISTS kind, DROP COLUMN IF EXISTS order_ids;
