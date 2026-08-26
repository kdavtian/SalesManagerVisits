-- A field rep's own out-of-pocket cash spend (fuel, parking, small
-- supplies) logged from the "Cash expense" quick action on Home. Date/time
-- are always "now" at creation (see the route), not user-editable, so the
-- record stays an honest log of when it was actually entered.
CREATE TABLE cash_expenses (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  amount_amd  NUMERIC NOT NULL CHECK (amount_amd > 0),
  purpose     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cash_expenses_user_id_created_at ON cash_expenses (user_id, created_at DESC);
