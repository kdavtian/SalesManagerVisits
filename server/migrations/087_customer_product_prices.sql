-- Individually negotiated prices for Gold customers. Only honoured for
-- customers whose tier is currently gold; set by director-and-above roles
-- from the order form.
CREATE TABLE customer_product_prices (
  customer_id integer NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price_amd numeric(14,2) NOT NULL CHECK (price_amd >= 0),
  set_by integer REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id)
);
