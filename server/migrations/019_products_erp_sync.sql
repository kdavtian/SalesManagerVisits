ALTER TABLE products ADD COLUMN erp_product_id TEXT UNIQUE;
ALTER TABLE products ADD COLUMN synced_at TIMESTAMPTZ;
-- Set whenever an admin edits a product through the app; a sync then skips
-- that row rather than overwriting the manual correction, mirroring how a
-- rep's manual region/subregion edit on a customer already survives sync.
ALTER TABLE products ADD COLUMN manually_edited_at TIMESTAMPTZ;
