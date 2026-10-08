-- Final (signed) accounting documents that Lily sends back: stored in the
-- database next to the order (and shown on the customer). PDF only, size
-- capped by the upload endpoint.
CREATE TABLE order_documents (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  hc_doc_number TEXT,
  kind TEXT NOT NULL DEFAULT 'signed_copy' CHECK (kind IN ('signed_copy')),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/pdf',
  size_bytes INTEGER NOT NULL,
  data BYTEA NOT NULL,
  uploaded_by_token INTEGER REFERENCES integration_tokens(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_documents_order_idx ON order_documents (order_id);
-- Re-sending the same document number replaces it (see the upload endpoint).
CREATE UNIQUE INDEX order_documents_order_doc_uniq ON order_documents (order_id, hc_doc_number) WHERE hc_doc_number IS NOT NULL;
