-- Orders page: the desktop "Amount" column heading sorts the whole history (GET /orders?sort=amount). Without this index
-- that is a sequential scan + top-N sort (about 56 ms at 60,000 orders); with it page 1 is an index scan (about 1 ms).
-- Matches ORDER BY o.total_amd DESC, o.id DESC exactly (the reverse direction scans the same index backwards).
CREATE INDEX IF NOT EXISTS orders_total_amd_idx ON orders (total_amd DESC, id DESC);

-- The "Status" heading sorts by the order flow (draft, submitted, confirmed, packed, delivered), not alphabetically; that
-- CASE expression cannot use the plain status index (about 88 ms at 60,000 orders), so it gets its own expression index
-- (routes/orders.js ORDER_STATUS_FLOW must keep the same CASE or the planner will not use it).
CREATE INDEX IF NOT EXISTS orders_status_flow_idx ON orders (
  (CASE status WHEN 'draft' THEN 0 WHEN 'submitted' THEN 1 WHEN 'confirmed' THEN 2 WHEN 'packed_stock_out' THEN 3 WHEN 'delivered' THEN 4 ELSE 5 END),
  created_at DESC,
  id DESC
);
