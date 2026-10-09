-- "From ERP": an order that already appears in the ERP workbook has been
-- delivered, and a submitted cash payment that already appears in the ERP
-- payments has been received. The sync marks those automatically; these
-- columns record that it was the ERP and what it matched, so the app can show
-- a "From ERP" chip and never match the same ERP row twice.
ALTER TABLE orders
  ADD COLUMN delivered_from_erp BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN erp_matched_order_id TEXT;
CREATE UNIQUE INDEX orders_erp_matched_order_idx ON orders (erp_matched_order_id) WHERE erp_matched_order_id IS NOT NULL;

ALTER TABLE payments
  ADD COLUMN approved_from_erp BOOLEAN NOT NULL DEFAULT false,
  -- customer|date|amount of the ERP payment row it matched (the ERP table is
  -- replaced on every sync, so row ids are not stable).
  ADD COLUMN erp_match_key TEXT;
CREATE INDEX payments_erp_match_key_idx ON payments (erp_match_key) WHERE erp_match_key IS NOT NULL;
