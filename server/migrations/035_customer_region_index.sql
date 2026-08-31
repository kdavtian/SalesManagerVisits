-- visit_plan_rules areas (region/subregion filters) and the customer list's
-- region/subregion filter dropdowns both scan customers by these columns;
-- neither had an index, so both degraded to a sequential scan as the
-- customer list grew. Composite index covers "all of a region" lookups and,
-- since subregion is the trailing column, also serves plain region-only
-- lookups without needing a second single-column index.
CREATE INDEX IF NOT EXISTS idx_customers_region_subregion ON customers (region, subregion);
