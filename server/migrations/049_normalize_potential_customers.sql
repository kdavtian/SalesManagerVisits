-- Portfolio rule: every non-competitor customer without an ERP customer ID
-- is Potential. Competitors remain a separate portfolio segment.
UPDATE customers
SET customer_tier = 'potential'
WHERE COALESCE(btrim(erp_customer_id), '') = ''
  AND customer_tier IS DISTINCT FROM 'competitor';
