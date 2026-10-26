-- Electronic signature of the delivery-acceptance act (owner, 2026-10-26).
-- users.signature_path: the rep's (or driver's) own signature, drawn once and applied silently to every act they hand over.
-- customer_signatures: the customer's signature given on the rep's phone at a visit (one for all orders delivered at that visit).
-- orders.signed_at / signature_id: the order is locked once the customer signed; only admin and CEO may change it afterwards.
ALTER TABLE users ADD COLUMN IF NOT EXISTS signature_path text;

CREATE TABLE IF NOT EXISTS customer_signatures (
  id          serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  checkin_id  integer REFERENCES checkins(id) ON DELETE SET NULL,
  file_path   text NOT NULL,
  signed_at   timestamptz NOT NULL DEFAULT now(),
  created_by  integer REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_customer_signatures_checkin ON customer_signatures (checkin_id);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS signed_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS signature_id integer REFERENCES customer_signatures(id) ON DELETE SET NULL;
