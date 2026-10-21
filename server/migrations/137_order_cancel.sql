-- KAD OS customer cancels or changes an app order until KAD Motors CONFIRMS it (owner, 2026-10-21).
-- A cancelled app order is kept as a record: it goes back to "draft" (so it leaves every live queue, stock hold and credit exposure) and is
-- marked here, which is what tells it apart from a draft that was only sent back for a correction. Nobody can submit it again.
--   cancelled_at          : when the customer cancelled it (NULL for every ordinary order)
--   cancel_reason         : the customer's own words (optional)
--   replaced_by_order_id  : set when the customer CHANGED the order -- the new order that took its place
ALTER TABLE orders
  ADD COLUMN cancelled_at          TIMESTAMPTZ,
  ADD COLUMN cancel_reason         TEXT,
  ADD COLUMN replaced_by_order_id  INTEGER REFERENCES orders(id) ON DELETE SET NULL;
CREATE INDEX orders_cancelled_idx ON orders (cancelled_at) WHERE cancelled_at IS NOT NULL;
