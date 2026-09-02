-- Payments Collection & Approval ecosystem. A Sales Manager records money
-- received from a customer in the field; the submission is immutable and
-- starts PENDING. An Accountant (or CEO) reviews it against the accounting
-- books they maintain separately in Excel and either APPROVEs (confirms
-- receipt/reconciliation) or REJECTs it with a reason. This is a distinct,
-- newer workflow from the older ad-hoc "amount_collected_amd" field on
-- checkins (see checkins table) -- that field just marks "money changed
-- hands during this visit" with no review step; this table is the
-- reconciled, audited source of truth for actual collection reporting.
--
-- customer_name_snapshot/erp_customer_id_snapshot/sales_manager_name_snapshot
-- freeze what was true at submission time -- a payment's accounting record
-- must never silently change if the customer is renamed or re-linked later.
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  customer_name_snapshot TEXT NOT NULL,
  erp_customer_id_snapshot TEXT,
  amount_amd NUMERIC(14, 2) NOT NULL CHECK (amount_amd > 0 AND amount_amd < 100000000000),
  payment_date TIMESTAMPTZ NOT NULL,
  sales_manager_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  sales_manager_name_snapshot TEXT NOT NULL,
  sales_channel TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  rejected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  -- Client-generated idempotency key: a retried/duplicate submission from
  -- the same device after a flaky connection reuses the same ref and hits
  -- the unique index below instead of creating a second payment.
  client_ref TEXT
);

CREATE UNIQUE INDEX payments_created_by_client_ref_idx ON payments (created_by, client_ref) WHERE client_ref IS NOT NULL;

-- Every one of these mirrors a real query shape used by the list/report
-- endpoints: status alone (badges/counts), payment_date alone (recency),
-- and the three compound pairs the spec calls out explicitly.
CREATE INDEX payments_status_idx ON payments (status);
CREATE INDEX payments_payment_date_idx ON payments (payment_date DESC);
CREATE INDEX payments_status_date_idx ON payments (status, payment_date DESC);
CREATE INDEX payments_manager_date_idx ON payments (sales_manager_id, payment_date DESC);
CREATE INDEX payments_channel_date_idx ON payments (sales_channel, payment_date DESC);
CREATE INDEX payments_customer_idx ON payments (customer_id);
CREATE INDEX payments_erp_id_idx ON payments (erp_customer_id_snapshot);

-- Full audit trail: created, approved, rejected, and returned-to-pending
-- (a correction after approval/rejection) each get a row here, so the
-- current status columns on `payments` are a fast-path snapshot, not the
-- only record.
CREATE TABLE payment_status_history (
  id SERIAL PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  old_status TEXT,
  new_status TEXT NOT NULL,
  reason TEXT,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payment_status_history_payment_id_idx ON payment_status_history (payment_id, changed_at DESC);
