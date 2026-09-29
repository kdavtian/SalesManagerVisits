-- Per-line discount/price-adjustment amount from the ERP extract's own
-- Orders sheet (Castrol's own "Discount" column, one row per product on
-- an order) -- purely informational, never used to re-derive revenue_amd
-- or any order/day total: those already reflect whatever the ERP sheet's
-- own revenue figure is, discount included or not. Stored with whatever
-- sign the ERP sends (see docs/erp-sync-contract.md) and displayed as-is,
-- rather than the app assuming a direction.
ALTER TABLE erp_order_lines ADD COLUMN discount_amd NUMERIC;
