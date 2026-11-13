-- Electronic signature, step 1: the signing engine (owner, 2026-11-13; design: kad-gmm docs/e-signature.md). KAD Motors makes a DOCUMENT
-- (a frozen copy of the numbers, a number, KAD's side already signed) for a customer; the customer's KAD OS lists it through the partner API
-- and its chosen signer signs it (drawn signature + personal PIN checked in KAD OS) or disputes it. What is signed never changes: a correction
-- is a new version (same number, version + 1; the old row becomes 'replaced'). Backward compatible: new tables and columns only.
CREATE SEQUENCE IF NOT EXISTS partner_document_number_seq;

CREATE TABLE IF NOT EXISTS partner_documents (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('delivery', 'payment', 'reconciliation', 'return', 'deal', 'agreement')),
  -- ACT-YYYY-NNNNNN; every version of one document keeps its number, so (number, version) is the unique pair
  number TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  state TEXT NOT NULL DEFAULT 'sent' CHECK (state IN ('sent', 'viewed', 'signed', 'signed_remarks', 'disputed', 'replaced', 'cancelled')),
  title TEXT NOT NULL,
  -- frozen when sent: { summary: [{label, value}], lines: [{key, name, qty, unit, price_amd, amount_amd, note}], totals: [{label, amount_amd}],
  --                    text, lines_disputable }
  content JSONB NOT NULL,
  -- sha256 hex of the canonical JSON of { content, customer_id, kind, number, version } (orders/documentFingerprint.js)
  fingerprint TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  viewed_at TIMESTAMPTZ,
  signed_at TIMESTAMPTZ,
  -- KAD Motors' side, signed when sent: { user_id, name, role, signed_at, signature_path }
  kad_signer JSONB,
  -- the customer's signer: { name, role, user_ref, signed_at, ip, ua, app_version, pin_verified, fingerprint }
  customer_signer JSONB,
  -- the customer's signature image, a PNG under the upload folder (signatures/<uuid>.png)
  signature_path TEXT,
  -- what the customer marked on lines: [{ key, issue, qty, comment }]
  remarks JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- { reason, comment, at, by: {name, role, user_ref, ip, ua}, answer, answered_at, answered_by }
  dispute JSONB,
  replaces_id INTEGER REFERENCES partner_documents(id) ON DELETE SET NULL,
  replaced_by_id INTEGER REFERENCES partner_documents(id) ON DELETE SET NULL,
  -- what the document proves
  order_ids INTEGER[] NOT NULL DEFAULT '{}',
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  return_id INTEGER,
  -- the PDFs (file names under the upload folder): the unsigned one (KAD signed, customer line empty) and the signed one
  pdf_path TEXT,
  signed_pdf_path TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_reason TEXT,
  cancelled_at TIMESTAMPTZ,
  -- the overdue reminder (jobs: partner-document-reminders) runs at most once a day per document
  last_reminded_at TIMESTAMPTZ,
  UNIQUE (number, version)
);
CREATE INDEX IF NOT EXISTS partner_documents_customer_idx ON partner_documents (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS partner_documents_state_idx ON partner_documents (state, created_at DESC);
CREATE INDEX IF NOT EXISTS partner_documents_open_due_idx ON partner_documents (due_at) WHERE state IN ('sent', 'viewed');
CREATE INDEX IF NOT EXISTS partner_documents_orders_idx ON partner_documents USING GIN (order_ids);

-- "Send me a debt act now" from KAD OS (POST /api/partner/documents/request): recorded, the accountants are told.
CREATE TABLE IF NOT EXISTS partner_document_requests (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('delivery', 'payment', 'reconciliation', 'return', 'deal', 'agreement')),
  note TEXT,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at TIMESTAMPTZ,
  document_id INTEGER REFERENCES partner_documents(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS partner_document_requests_open_idx ON partner_document_requests (created_at DESC) WHERE handled_at IS NULL;

-- The signed PDF is also a customer document (the customer card's Files, the Documents inbox): a new kind, linked to its document.
ALTER TABLE customer_files DROP CONSTRAINT IF EXISTS customer_files_kind_check;
ALTER TABLE customer_files ADD CONSTRAINT customer_files_kind_check CHECK (kind IN ('order_blank', 'signed_act', 'payment_slip', 'signed_document', 'other'));
ALTER TABLE customer_files ADD COLUMN IF NOT EXISTS partner_document_id INTEGER REFERENCES partner_documents(id) ON DELETE SET NULL;

-- The rep's task when a document is past its deadline and still not signed (nothing is accepted by silence, design decision 4).
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_auto_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_auto_kind_check CHECK (auto_kind IN
  ('debt_collection', 'reorder_followup', 'dead_stock', 'fx_review', 'excel_upload', 'data_quality', 'data_missing', 'order_waiting', 'downpayment',
   'cash_handoff_unconfirmed', 'cash_sheet_not_recorded', 'cash_discrepancy', 'order_not_in_excel', 'document_unsigned'));
