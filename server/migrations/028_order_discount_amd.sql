-- A flat-AMD discount alongside the existing percent one -- a manager
-- negotiating "take off 5,000 AMD" doesn't want to convert that to a
-- percentage by hand. The two are mutually exclusive per order (enforced
-- in routes/orders.js, not here): whichever is nonzero wins.
ALTER TABLE orders ADD COLUMN discount_amd NUMERIC NOT NULL DEFAULT 0 CHECK (discount_amd >= 0);
