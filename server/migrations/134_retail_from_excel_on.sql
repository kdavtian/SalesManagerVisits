-- Owner, 2026-10-20: "prices should be taken from the Excel Products sheet (gold, silver, bronze, retail)". Retail from Excel was
-- shipped switched OFF in 1.370.0 so the owner could look at the differences first; the owner now wants it ON. This switches it on
-- once and applies the Excel retail prices already stored (erp_retail_price_amd) at once, like the switch's own action does
-- (landingCalc.js applyExcelRetail): every change goes to the price history. It can be switched off again in App configuration.
-- A product whose workbook retail is empty keeps the app's own retail.
UPDATE app_settings SET retail_from_excel = true WHERE id = 1 AND retail_from_excel IS NOT TRUE;

WITH changed AS (
  UPDATE products p SET retail_price_amd = p.erp_retail_price_amd, updated_at = now()
    FROM (SELECT id, retail_price_amd AS old FROM products) s
   WHERE p.id = s.id AND p.erp_retail_price_amd > 0 AND p.retail_price_amd IS DISTINCT FROM p.erp_retail_price_amd
     AND EXISTS (SELECT 1 FROM app_settings WHERE id = 1 AND retail_from_excel)
  RETURNING p.id, s.old AS old_value, p.retail_price_amd AS new_value
)
INSERT INTO product_price_history (product_id, price_type, old_value, new_value, changed_by, note)
SELECT id, 'retail', old_value, new_value, NULL, 'Retail from Excel switched on' FROM changed WHERE old_value IS NOT NULL AND old_value <> new_value;
