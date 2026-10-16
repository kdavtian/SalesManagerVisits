-- GET /products counts, per product, the pieces already promised to other orders (reserved_qty): one subquery per product
-- over order_items by product_id. order_items had an index on order_id only, so every product scanned the whole table
-- (300 products x every order line); with the order history growing that made the Products / New order screens slower
-- every week. This index turns each of those lookups into a few rows read.
CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items (product_id);
