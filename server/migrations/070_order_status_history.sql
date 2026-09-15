-- Full order-status timeline (created -> submitted -> confirmed ->
-- packed -> delivered, with exception loops back to draft along the way)
-- -- same shape as the existing payment_status_history table, which this
-- deliberately mirrors, so both timelines render/behave the same way.
-- Populated at every real status transition in orders.js/warehouse.js/
-- delivery.js; read by GET /orders/:id alongside the order itself.
CREATE TABLE order_status_history (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_id_idx ON order_status_history (order_id, changed_at ASC);
