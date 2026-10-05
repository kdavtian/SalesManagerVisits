-- Lily (AI accountant) integration: an order that management confirms can be
-- sent to accounting for a waybill (Բեռնագիր, cash orders) or a tax invoice
-- (Հաշիվ ապրանքագիր, invoice orders). Lily pulls pending requests through the
-- token-authenticated /api/integration/v1 API, claims them and reports back.
-- She never edits the order itself -- everything she writes lives in these
-- accounting_* columns.
ALTER TABLE orders
  ADD COLUMN accounting_doc_type TEXT CHECK (accounting_doc_type IN ('waybill', 'invoice')),
  ADD COLUMN accounting_status TEXT CHECK (
    accounting_status IN ('pending', 'in_progress', 'document_created', 'exported_unsigned', 'signed', 'needs_attention')
  ),
  ADD COLUMN accounting_is_test BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN accounting_requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN accounting_requested_at TIMESTAMPTZ,
  ADD COLUMN accounting_claimed_at TIMESTAMPTZ,
  ADD COLUMN accounting_documents JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN accounting_error JSONB,
  ADD COLUMN accounting_updated_at TIMESTAMPTZ;

CREATE INDEX orders_accounting_status_idx ON orders (accounting_status) WHERE accounting_status IS NOT NULL;

-- KAD product -> HC (ՀԾ-Հաշվապահ) product code, maintained by management.
ALTER TABLE products ADD COLUMN hc_code TEXT;

-- Integration tokens: only a SHA-256 of the token is stored, the plaintext is
-- shown once at creation. Revoking sets revoked_at.
CREATE TABLE integration_tokens (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  test_mode BOOLEAN NOT NULL DEFAULT false,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE integration_audit_log (
  id BIGSERIAL PRIMARY KEY,
  token_id INTEGER REFERENCES integration_tokens(id) ON DELETE SET NULL,
  token_name TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER,
  order_id INTEGER,
  idempotency_key TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX integration_audit_log_created_idx ON integration_audit_log (created_at DESC);

CREATE TABLE integration_idempotency (
  token_id INTEGER NOT NULL REFERENCES integration_tokens(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, idempotency_key)
);
