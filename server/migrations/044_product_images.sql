-- Product photo (item 25/38): a single image per product, same upload
-- pattern as user avatars and checkin photos (server/src/upload.js).
-- Nullable -- most of the catalog has no photo yet, and the UI must
-- fall back to a placeholder rather than assume one exists.
ALTER TABLE products ADD COLUMN image_path TEXT;
