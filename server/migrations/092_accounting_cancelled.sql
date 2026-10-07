-- A request to accounting can be withdrawn: 'cancelled' is never claimed by
-- Lily (only 'pending' is) and can be re-sent or set back to any status.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_accounting_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_accounting_status_check CHECK (
  accounting_status IN ('pending', 'in_progress', 'waybill_created', 'partially_created', 'exported_unsigned', 'signed', 'needs_attention', 'cancelled')
);
