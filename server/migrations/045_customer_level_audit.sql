-- Audit trail for automatic customer_tier changes (currently just the
-- Potential -> Bronze upgrade that fires when a customer first gets linked
-- to an ERP Customer ID -- see customers.js PATCH handler). Manual tier
-- edits by a user aren't logged here; this table exists specifically so a
-- silent system-driven level change is still traceable.
CREATE TABLE customer_level_audit (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  old_tier TEXT,
  new_tier TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX customer_level_audit_customer_id_idx ON customer_level_audit (customer_id, changed_at DESC);
