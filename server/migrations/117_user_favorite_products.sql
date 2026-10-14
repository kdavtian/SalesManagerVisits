-- Each user's favorite products (the star on the New order screen): one row per user + product, kept on the server
-- so favorites follow the person to another phone and survive a reinstall.
CREATE TABLE user_favorite_products (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);
