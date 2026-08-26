-- A human-readable order code (YYMMDD + 2-digit daily sequence, e.g. the
-- 1st order on 2026-05-30 is "26053001") so a CEO/director can reference an
-- order out loud without reciting the internal numeric id. daily_order_seq
-- tracks the next sequence number per calendar day; the atomic
-- INSERT ... ON CONFLICT ... RETURNING pattern in routes/orders.js avoids a
-- race between two orders placed in the same second.
CREATE TABLE daily_order_seq (
  day DATE PRIMARY KEY,
  seq INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE orders ADD COLUMN order_code TEXT;
CREATE UNIQUE INDEX idx_orders_order_code ON orders (order_code) WHERE order_code IS NOT NULL;

-- Snapshotted alongside product_name/unit_price_amd at order time -- a
-- manager's order can mix e.g. Lotos 5W-30 1L and Royal 5W-30 1L, and
-- without the brand on each line the final order looks like duplicate
-- entries. Snapshotting (rather than joining products.brand at read time)
-- keeps this stable even if the catalog product is later renamed/removed.
ALTER TABLE order_items ADD COLUMN brand TEXT;
