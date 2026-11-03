-- Frozen credit (owner, 2026-11-03): an amount of a customer's debt that is set aside (frozen) and does not count for chasing or for the order
-- credit check: NET debt = live debt - frozen, never below 0 (shared function client/public/js/shared/netDebt.js). Set next to the credit limit by
-- the accountant / directors. Default 0 = nothing frozen: every number stays what it was.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS frozen_credit_amd NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (frozen_credit_amd >= 0);

CREATE TABLE IF NOT EXISTS customer_frozen_credit_log (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  old_amount NUMERIC(14, 2) NOT NULL,
  new_amount NUMERIC(14, 2) NOT NULL,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_frozen_credit_log_customer_idx ON customer_frozen_credit_log (customer_id, changed_at DESC);
