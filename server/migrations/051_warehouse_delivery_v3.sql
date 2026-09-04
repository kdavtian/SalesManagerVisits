-- Warehouse & Delivery Module v3: collapses the 10-state status machine
-- from 050_warehouse_delivery.sql down to 5 states, per the "KAD Motors --
-- Warehouse & Delivery Module Spec (v3 -- Final)":
--
--   draft -> submitted -> confirmed -> packed_stock_out -> delivered
--
-- Every exception (director reject, WM stock issue, failed delivery) loops
-- straight back to "draft" instead of a dedicated status -- there is no
-- longer a separate warehouse_review/stock_issue/out_for_delivery/
-- returned/cancelled state. A rejected/failed order is edited and
-- resubmitted the same way a fresh draft is.
--
-- Backfill mapping for any order caught mid-flight under the old machine:
--   warehouse_review, stock_issue          -> confirmed / draft (see below)
--   packed, out_for_delivery               -> packed_stock_out
--   returned                               -> draft
--   cancelled                              -> draft (nothing better to map
--                                              a cancelled order to under a
--                                              status machine with no
--                                              terminal "dead" state; its
--                                              note/history still records
--                                              why)
UPDATE orders SET status = 'confirmed' WHERE status = 'warehouse_review';
UPDATE orders SET status = 'draft' WHERE status = 'stock_issue';
UPDATE orders SET status = 'packed_stock_out' WHERE status IN ('packed', 'out_for_delivery');
UPDATE orders SET status = 'draft' WHERE status IN ('returned', 'cancelled');

ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('draft', 'submitted', 'confirmed', 'packed_stock_out', 'delivered'));

-- Renamed from stock_issue_note: this column now records why an order
-- landed back at "draft" from any exception path (director reject, WM
-- stock issue, failed delivery), not just the stock-issue one.
ALTER TABLE orders RENAME COLUMN stock_issue_note TO draft_reason;

-- Accountant "Recorded" checkbox (spec section 6): marks that a delivered
-- order's signature/debt/payment info has been checked against the Excel
-- books. This module does not itself track payment approval or debt aging
-- -- Excel remains that source of truth -- "recorded" is just an
-- acknowledgement flag so nothing silently falls through the cracks.
ALTER TABLE orders ADD COLUMN recorded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN recorded_at TIMESTAMPTZ;

-- Out of scope per v3 (section 9: "does NOT build a competing ledger,
-- payment-approval workflow, or debt/aging system"). Payment collected on
-- delivery becomes an informational field on pod_records instead of a
-- payments-table row requiring accountant approval.
DROP INDEX IF EXISTS payments_order_id_idx;
ALTER TABLE payments DROP COLUMN IF EXISTS order_id;
ALTER TABLE customers DROP COLUMN IF EXISTS credit_term_days;

-- Informational-only payment method captured on delivery, alongside the
-- amount already on this table.
ALTER TABLE pod_records ADD COLUMN payment_method TEXT CHECK (payment_method IN ('cash', 'other'));
