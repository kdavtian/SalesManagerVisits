-- One-time backfill matching the new create/edit-time rule: a customer that
-- already has an ERP customer ID linked should never sit at "Potential" --
-- see customers.js POST/PATCH handlers and 045_customer_level_audit.sql for
-- the equivalent live auto-upgrade this mirrors for existing rows. Only
-- customers still on the default "potential" tier are touched; any customer
-- already manually set to Silver/Gold (or Bronze) is left untouched.
--
-- Every row this changes is also logged to customer_level_audit (same
-- reason string as the live auto-upgrade) so the affected customers can be
-- listed afterwards with:
--   SELECT c.id, c.name, c.erp_customer_id, a.changed_at
--   FROM customer_level_audit a JOIN customers c ON c.id = a.customer_id
--   WHERE a.reason = 'ERP ID assigned (bulk normalization)'
--   ORDER BY c.name;
WITH upgraded AS (
  UPDATE customers
  SET customer_tier = 'bronze'
  WHERE customer_tier = 'potential'
    AND COALESCE(btrim(erp_customer_id), '') <> ''
  RETURNING id
)
INSERT INTO customer_level_audit (customer_id, old_tier, new_tier, reason, changed_by)
SELECT id, 'potential', 'bronze', 'ERP ID assigned (bulk normalization)', NULL
FROM upgraded;
