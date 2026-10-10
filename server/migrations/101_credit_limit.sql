-- Credit terms (owner's request): an optional per-customer credit limit set by
-- the accountant/management. An order that would push the customer's exposure
-- (Excel debt + open app orders + this order) over the limit needs a
-- director's approval (sales director, CEO, operations director, admin)
-- before it can be confirmed -- same idea as the discount approval.
ALTER TABLE customers
  ADD COLUMN credit_limit_amd NUMERIC(14, 2) CHECK (credit_limit_amd IS NULL OR credit_limit_amd >= 0);

ALTER TABLE orders
  ADD COLUMN credit_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (credit_status IN ('not_required', 'pending', 'approved', 'rejected')),
  ADD COLUMN credit_exposure_amd NUMERIC(14, 2),
  ADD COLUMN credit_limit_snapshot_amd NUMERIC(14, 2),
  ADD COLUMN credit_decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN credit_decided_at TIMESTAMPTZ;
