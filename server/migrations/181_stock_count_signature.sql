-- The stock count's evidence (owner, 2026-11-03): the warehouse manager signs the day on the phone (mandatory), may add a photo or a PDF of
-- the paper count (optional), and the day's report is saved as a PDF for the accountants and the bosses. A day closed automatically in the
-- evening has no signature (nobody signed) -- its PDF says so. All columns added and nullable: old rows and old clients are unaffected.
ALTER TABLE stock_count_days
  ADD COLUMN IF NOT EXISTS signature_path  TEXT,
  ADD COLUMN IF NOT EXISTS signed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attachment_path TEXT,
  ADD COLUMN IF NOT EXISTS attachment_mime TEXT,
  ADD COLUMN IF NOT EXISTS pdf_path        TEXT;
