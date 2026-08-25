-- Product family (Edge/Magnatec/GTX/Vecton/...) for the order-entry
-- brand -> family -> variant drill-down, per-tier pricing (bronze/silver/
-- gold, one column each so an order can price a line by the customer's
-- tier without a lookup table), and stock_qty for availability checks at
-- order time.
--
-- The PriceList sheet doesn't yet carry three distinct tier prices --
-- until it does, bronze and silver both sync from the same "Price T1"
-- column and gold from "GMM Price T3" (see sync_field_visits.py). Existing
-- unit_price_amd stays in sync with bronze_price_amd so the pre-#121
-- order flow (which only knows unit_price_amd) keeps working unchanged.
ALTER TABLE products ADD COLUMN family TEXT;
ALTER TABLE products ADD COLUMN bronze_price_amd NUMERIC;
ALTER TABLE products ADD COLUMN silver_price_amd NUMERIC;
ALTER TABLE products ADD COLUMN gold_price_amd NUMERIC;
ALTER TABLE products ADD COLUMN stock_qty INTEGER;

UPDATE products SET bronze_price_amd = unit_price_amd WHERE bronze_price_amd IS NULL;
