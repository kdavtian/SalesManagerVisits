-- Landing cost calculated by the app from the pack's supplier price in USD (owner, 2026-10-19), and Retail price
-- taken from the Excel Retail Price column. The bot now also sends, per product: Pack Cost USD, Items per Pack,
-- Pack Netto kg, Size L and the workbook's Retail Price (all optional: an older bot still works).
--   landing_cost_amd      = what the app shows and uses (stock value, discount floor, below-landing alerts)
--   landing_workbook_amd  = the workbook's own Landing Cost AMD, kept for comparison and as the fallback
--   landing_source        = 'calculated' (from the pack price) or 'workbook' (no pack data / calculation is off / outlier)
--   erp_retail_price_amd  = the workbook's Retail Price; copied into retail_price_amd only while retail_from_excel is on
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS pack_cost_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS items_per_pack NUMERIC,
  ADD COLUMN IF NOT EXISTS pack_netto_kg NUMERIC,
  ADD COLUMN IF NOT EXISTS size_l NUMERIC,
  ADD COLUMN IF NOT EXISTS landing_workbook_amd NUMERIC,
  ADD COLUMN IF NOT EXISTS landing_source TEXT,
  ADD COLUMN IF NOT EXISTS erp_retail_price_amd NUMERIC;
-- Until the first calculation the workbook's value is what the app has been showing.
UPDATE products SET landing_workbook_amd = landing_cost_amd, landing_source = 'workbook' WHERE landing_cost_amd IS NOT NULL AND landing_workbook_amd IS NULL;

ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS landing_calc_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS landing_usd_rate NUMERIC(8, 2) NOT NULL DEFAULT 366,
  ADD COLUMN IF NOT EXISTS retail_from_excel BOOLEAN NOT NULL DEFAULT FALSE;
