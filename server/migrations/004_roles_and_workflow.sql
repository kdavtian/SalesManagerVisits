ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'manager', 'sales_director', 'warehouse_manager', 'delivery_manager'));

CREATE TABLE customer_edit_requests (
  id            SERIAL PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  requested_by  INTEGER NOT NULL REFERENCES users(id),
  changes       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  note          TEXT,
  reviewed_by   INTEGER REFERENCES users(id),
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_edit_requests_customer ON customer_edit_requests (customer_id);
CREATE INDEX idx_edit_requests_status ON customer_edit_requests (status);

-- Foreground-only live location: upserted while a field user has the app
-- open, never collected in the background. See chat / README for why.
CREATE TABLE user_locations (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lat         DOUBLE PRECISION NOT NULL,
  lng         DOUBLE PRECISION NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
