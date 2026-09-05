-- Item 6: re-introduce customers.credit_term_days (dropped in
-- 051_warehouse_delivery_v3.sql along with the rejected payment-approval/
-- aging/ledger system) as a plain informational/default field, plus a new
-- customers.payment_method (Cash/Invoice) and a per-order payment_method.
-- This is explicitly NOT a reintroduction of that rejected workflow: no
-- approval gates, no orders_status_check changes, no aging view. It only
-- gives an Invoice-type order's future due-date math something to key off.
ALTER TABLE customers ADD COLUMN credit_term_days INTEGER NOT NULL DEFAULT 45 CHECK (credit_term_days > 0);
ALTER TABLE customers ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'invoice' CHECK (payment_method IN ('cash', 'invoice'));

-- Nullable at the DB level since existing orders predate this field --
-- "required" is enforced in the order-create frontend form, not here, so
-- old rows aren't broken by a NOT NULL constraint.
ALTER TABLE orders ADD COLUMN payment_method TEXT CHECK (payment_method IN ('cash', 'invoice'));
