-- One-time data seeds (e.g. product photos/specs taken from the company's
-- pricelist workbook) record that they ran, so a deploy never re-applies one
-- after someone deliberately removed a photo.
CREATE TABLE IF NOT EXISTS data_seeds (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result JSONB
);
