-- Admin-entered net cost per product, alongside the existing ERP-synced
-- landing_cost_amd (migration 064). Unlike landing cost, there is no ERP
-- source for this figure -- it is set and maintained by hand in the admin
-- Product edit sheet, the same way retail_price_amd is.
ALTER TABLE products ADD COLUMN net_cost_amd NUMERIC;
