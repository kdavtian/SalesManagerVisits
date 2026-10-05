-- Align accounting statuses with the final KAD <-> Lily spec: the
-- "document_created" status is called "waybill_created", and a new
-- "partially_created" status covers orders where some lines are not yet in a
-- waybill.
ALTER TABLE orders DROP CONSTRAINT orders_accounting_status_check;
UPDATE orders SET accounting_status = 'waybill_created' WHERE accounting_status = 'document_created';
ALTER TABLE orders ADD CONSTRAINT orders_accounting_status_check CHECK (
  accounting_status IN ('pending', 'in_progress', 'waybill_created', 'partially_created', 'exported_unsigned', 'signed', 'needs_attention')
);
