-- Visit outcome becomes multi-select; brand presence becomes per-brand status tags.
-- Old `outcome` / `brands_found` columns are kept (read-only) so existing
-- check-in history keeps rendering; new check-ins write to the new columns.
ALTER TABLE checkins ADD COLUMN outcomes TEXT[];
ALTER TABLE checkins ADD COLUMN brand_status JSONB;

UPDATE checkins SET outcomes = ARRAY[outcome] WHERE outcome IS NOT NULL AND outcomes IS NULL;
