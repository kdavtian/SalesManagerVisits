-- Owner, 2026-11-07: admin, CEO and the accountant can correct an order at any stage (confirmed, packed, delivered) when staff made a
-- mistake; every correction is kept: who, when, why, and the order before and after.
CREATE TABLE IF NOT EXISTS order_corrections (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  corrected_by integer REFERENCES users(id) ON DELETE SET NULL,
  corrected_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL,
  before jsonb NOT NULL,
  after jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_corrections_order ON order_corrections (order_id, corrected_at DESC);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS corrected_at timestamptz;
