-- New order sheet (1.334.0): "Payment due" is now asked for cash orders too (0 = pay on delivery), and every order
-- can carry a downpayment (advance) the customer pays up front. Informational like the payment method: it is shown on
-- the order and available to the accountant / Lily; it does not create an accounting entry by itself.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_term_days_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_term_days_check CHECK (payment_term_days IS NULL OR payment_term_days BETWEEN 0 AND 365);
-- NULL = not asked (orders made before this field existed); 0 = the rep set "no downpayment".
ALTER TABLE orders ADD COLUMN IF NOT EXISTS downpayment_pct NUMERIC(5,2) CHECK (downpayment_pct IS NULL OR downpayment_pct BETWEEN 0 AND 100);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS downpayment_amd NUMERIC(14,2) CHECK (downpayment_amd IS NULL OR downpayment_amd >= 0);
