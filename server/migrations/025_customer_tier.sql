-- Customer relationship tier -- distinct from `category` (what kind of
-- business they are). "potential" and "competitor" customers have no ERP
-- Customer ID (they're not real paying accounts yet, or never will be);
-- bronze/silver/gold are real accounts, each priced from a different
-- column in the Castrol PriceList sheet (see products.silver_price_amd /
-- gold_price_amd).
ALTER TABLE customers ADD COLUMN customer_tier TEXT NOT NULL DEFAULT 'potential'
  CHECK (customer_tier IN ('potential', 'bronze', 'silver', 'gold', 'competitor'));
