-- The visit lists (Activity, a customer's card and photo gallery) look up "the order created at this visit" once per visit row. orders.checkin_id had no
-- index, so every visit row scanned the whole orders table: a customer with 400 visits took 4 s on 100,000 orders (owner, 2026-10-26: the customer card
-- and its photos load slowly). Partial index: most orders are not tied to a visit.
CREATE INDEX IF NOT EXISTS idx_orders_checkin_id ON orders (checkin_id) WHERE checkin_id IS NOT NULL;
