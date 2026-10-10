-- Who changed a customer's credit limit, when, and from what (append-only trail).
CREATE TABLE customer_credit_limit_log (
  id          SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  old_limit   NUMERIC(14, 2),
  new_limit   NUMERIC(14, 2),
  changed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customer_credit_limit_log_customer_idx ON customer_credit_limit_log (customer_id, changed_at DESC);
