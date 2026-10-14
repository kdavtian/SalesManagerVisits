-- How many days the customer has to pay an Invoice order (the "Payment due" field of the new order sheet,
-- defaulting to the customer's own credit term). NULL = cash order or an order made before this field existed.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_term_days INTEGER CHECK (payment_term_days IS NULL OR payment_term_days BETWEEN 1 AND 365);
