-- Prevents two different app customer records from ever being linked to
-- the same real-world ERP customer. Without this, debtBalances.js's own
-- JOIN customers c ON c.erp_customer_id = ecd.erp_customer_id could match
-- more than one customer row per ERP debt record, each potentially
-- carrying a different (or missing) assigned_manager_id -- surfacing as
-- "missing/incorrect assignment data in debt balances". See
-- src/routes/customers.js for the matching application-level check added
-- alongside this (returns a clear 409 instead of a raw constraint
-- violation when a rep tries to link an ERP ID that's already taken).
CREATE UNIQUE INDEX customers_erp_customer_id_unique_idx ON customers (erp_customer_id) WHERE erp_customer_id IS NOT NULL;

-- Superseded by the unique index above (same column, same partial
-- condition) -- keeping both would just double the write overhead on
-- every insert/update touching erp_customer_id for no benefit.
DROP INDEX IF EXISTS idx_customers_erp_customer_id;
