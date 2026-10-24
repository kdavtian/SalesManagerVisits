-- Order returns and cancellations (owner, 2026-10-24): a rep asks to return goods (a delivered order) or to cancel an order that is not delivered yet;
-- management approves; the warehouse manager confirms the goods are back (good / damaged); the accountant records it in Excel and the app follows.
-- Excel stays the truth for debt and stock: `credit_amd` is the provisional credit shown on the customer until the negative line arrives from Excel.
CREATE TABLE order_returns (
  id                  SERIAL PRIMARY KEY,
  order_id            INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_id         INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('return', 'cancel')),
  status              TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'done')),
  reason              TEXT NOT NULL CHECK (reason IN ('damaged', 'wrong_product', 'expired', 'changed_mind', 'quality', 'other')),
  note                TEXT,
  order_status_at_request TEXT NOT NULL,
  credit_amd          NUMERIC NOT NULL DEFAULT 0,
  requested_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at          TIMESTAMPTZ,
  decision_note       TEXT,
  received_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  received_at         TIMESTAMPTZ,
  recorded_at         TIMESTAMPTZ,                       -- the negative lines are in Excel / the accountant says so
  recorded_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recorded_via        TEXT CHECK (recorded_via IN ('erp', 'manual')),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_returns_order_idx ON order_returns (order_id);
CREATE INDEX order_returns_customer_idx ON order_returns (customer_id);
CREATE INDEX order_returns_status_idx ON order_returns (status, requested_at DESC);

CREATE TABLE order_return_items (
  id               SERIAL PRIMARY KEY,
  return_id        INTEGER NOT NULL REFERENCES order_returns(id) ON DELETE CASCADE,
  order_item_id    INTEGER REFERENCES order_items(id) ON DELETE SET NULL,
  product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name     TEXT NOT NULL,
  brand            TEXT,
  quantity         NUMERIC NOT NULL CHECK (quantity > 0),
  unit_credit_amd  NUMERIC NOT NULL DEFAULT 0,           -- the price the customer actually paid per unit (order discount included)
  line_credit_amd  NUMERIC NOT NULL DEFAULT 0,
  condition        TEXT CHECK (condition IN ('good', 'damaged'))  -- set by the warehouse manager when the goods are back
);
CREATE INDEX order_return_items_return_idx ON order_return_items (return_id);
