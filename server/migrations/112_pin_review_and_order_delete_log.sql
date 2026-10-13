-- Pin review: evidence that a customer's pin (not the rep's GPS) is wrong, and the order delete log.

-- GPS accuracy (meters) the phone reported at check-in, so a poor fix is not mistaken for a wrong pin.
ALTER TABLE checkins ADD COLUMN IF NOT EXISTS accuracy_m INTEGER;

-- When the customer's pin was last moved (any code path: edit, relocate, pin review). Check-ins from before
-- that moment say nothing about the current pin.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS pin_set_at TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION customers_touch_pin_set_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.pin_set_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS customers_pin_set_at ON customers;
CREATE TRIGGER customers_pin_set_at
  BEFORE UPDATE OF lat, lng ON customers
  FOR EACH ROW
  WHEN (OLD.lat IS DISTINCT FROM NEW.lat OR OLD.lng IS DISTINCT FROM NEW.lng)
  EXECUTE FUNCTION customers_touch_pin_set_at();

-- A sales manager refused at check-in for being too far (Check-in allowance) is still real evidence of where
-- they stood. The check-in itself is not saved, so the attempt is kept here, for the Pin review.
CREATE TABLE IF NOT EXISTS checkin_far_attempts (
  id              SERIAL PRIMARY KEY,
  customer_id     INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  lat             DOUBLE PRECISION NOT NULL,
  lng             DOUBLE PRECISION NOT NULL,
  distance_meters DOUBLE PRECISION NOT NULL,
  accuracy_m      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkin_far_attempts_customer_idx ON checkin_far_attempts (customer_id, created_at DESC);

-- "This pin is fine": the review ignores older evidence for that customer.
CREATE TABLE IF NOT EXISTS pin_review_dismissals (
  customer_id  INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  dismissed_by INTEGER REFERENCES users(id),
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A deleted order leaves no row (and its status history goes with it), so every deletion is logged here --
-- a sales manager may delete their own order until management confirms it.
CREATE TABLE IF NOT EXISTS deleted_orders_log (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL,
  order_code    TEXT,
  customer_id   INTEGER,
  customer_name TEXT,
  order_user_id INTEGER,
  status        TEXT,
  total_amd     NUMERIC,
  items         JSONB,
  deleted_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
