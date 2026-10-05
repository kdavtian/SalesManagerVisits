-- A waybill (Բեռնագիր) is only ever for a cash order and a tax invoice
-- (Հաշիվ ապրանքագիր) only for an invoice order. The app already derives the
-- document from the payment method; this makes it a database rule too.
-- Existing rows are normalised first: the document follows the payment
-- method, and a request on an order with no payment method is cleared.
UPDATE orders
SET accounting_doc_type = CASE payment_method WHEN 'cash' THEN 'waybill' WHEN 'invoice' THEN 'invoice' END
WHERE accounting_doc_type IS NOT NULL AND payment_method IS NOT NULL;

UPDATE orders
SET accounting_doc_type = NULL, accounting_status = NULL, accounting_requested_at = NULL, accounting_claimed_at = NULL,
    accounting_documents = '[]'::jsonb, accounting_error = NULL
WHERE accounting_doc_type IS NOT NULL AND payment_method IS NULL;

ALTER TABLE orders ADD CONSTRAINT orders_accounting_doc_matches_payment CHECK (
  accounting_doc_type IS NULL
  OR (accounting_doc_type = 'waybill' AND payment_method = 'cash')
  OR (accounting_doc_type = 'invoice' AND payment_method = 'invoice')
);
