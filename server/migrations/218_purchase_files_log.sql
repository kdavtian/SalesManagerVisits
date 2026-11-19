-- Purchases P3 (owner plan, 2026-11-20): the supplier's paper beside the typed invoice, and who changed what.
-- 1. purchase_files: a photo or PDF of the invoice (several per invoice), kept under uploads/purchases; gone with its invoice.
-- 2. purchase_log: every create / edit / delete of an invoice and every file added or removed, with who and when and the totals before and
--    after. No foreign key to the invoice on purpose: the history of a deleted invoice stays. Additive.
CREATE TABLE IF NOT EXISTS purchase_files (
  id            SERIAL PRIMARY KEY,
  invoice_id    INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size_bytes    INTEGER,
  original_name TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_files_invoice_idx ON purchase_files (invoice_id);

CREATE TABLE IF NOT EXISTS purchase_log (
  id          SERIAL PRIMARY KEY,
  invoice_id  INTEGER NOT NULL,
  invoice_no  TEXT,
  supplier    TEXT,
  action      TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'file_add', 'file_delete')),
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  details     JSONB
);
CREATE INDEX IF NOT EXISTS purchase_log_invoice_idx ON purchase_log (invoice_id, at);
