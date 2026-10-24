-- Payments an admin deleted (owner, 2026-10-24: "admin can delete payments"). Nothing is lost: the whole row and its
-- history are kept here, with who deleted it, when and why, so a deleted payment can always be explained.
CREATE TABLE deleted_payments (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL,
  payment JSONB NOT NULL,
  history JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason TEXT,
  deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_by_name TEXT,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deleted_payments_deleted_at_idx ON deleted_payments (deleted_at DESC);
