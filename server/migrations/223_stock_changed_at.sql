-- When the Excel stock of a product last CHANGED (owner, 2026-11-23, stock logic review). products.synced_at moves at every sync for every product
-- (erpSync.js upsert), so "returned / marked by hand after the last sync" read as "Excel has it now" one sync later, before the accountant had
-- entered anything. The app's stock rules (orders/appStock.js) compare with this instead. Additive: synced_at keeps meaning "last sync".
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_changed_at timestamptz;
UPDATE products SET stock_changed_at = synced_at WHERE stock_changed_at IS NULL AND synced_at IS NOT NULL;
