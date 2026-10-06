-- Product detail card: photos (front/back/other, one main), description,
-- approvals and specifications (entered by hand in the app or imported from
-- the pricelist workbook), and the commercial-oils flag the pricelist PDF
-- uses to split its Commercial section.
ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS approvals TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS specs JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_commercial BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS product_images (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('front', 'back', 'other')),
  is_main BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS product_images_product_idx ON product_images (product_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS product_images_one_main_idx ON product_images (product_id) WHERE is_main;

-- The single legacy photo (products.image_path) becomes the main front image.
INSERT INTO product_images (product_id, path, kind, is_main)
SELECT id, image_path, 'front', true FROM products
WHERE image_path IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = products.id);
