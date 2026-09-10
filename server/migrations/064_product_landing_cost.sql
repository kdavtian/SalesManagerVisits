-- Landing cost (the Castrol Pricelist sheet's own "Landing Cost" column, per
-- the same ERP sync pipeline that already feeds bronze/silver/gold_price_amd
-- from that sheet's price columns -- see migration 026 and
-- docs/erp-sync-contract.md). Warehouse-facing only (cost basis, not a
-- customer-facing price), so it's read-only in the app: never exposed on
-- any product edit form, only ever written by the sync.
ALTER TABLE products ADD COLUMN landing_cost_amd NUMERIC;
