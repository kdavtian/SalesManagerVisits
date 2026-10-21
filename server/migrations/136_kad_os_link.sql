-- KAD OS <-> KAD Motors link (owner, 2026-10-21). KAD Motors is the supplier; its wholesale customers run KAD OS (a free ERP) and order
-- from us inside it.
--   partner_links       : a KAD user account that belongs to ONE customer's KAD OS install (e.g. "KAD OS - Garage Masters Mall" -> 10001).
--                         Every order that account places is an "app order": it gets the app perks (discount, queue priority, delivery promise),
--                         the customer is forced to the linked one, and the account sees only that customer's data through /api/partner/*.
--   orders.placed_via_app / app_discount_pct / promised_date : the app order's marker, the discount that was given and the delivery target.
--   campaigns           : limited-time campaigns and bundles the supplier sends to all or selected customers (applied at order time, line level).
--   app_settings.app_orders : the perks' On/Off + numbers (App configuration), same pattern as the other settings.

CREATE TABLE partner_links (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX partner_links_customer_idx ON partner_links (customer_id);

CREATE TABLE campaigns (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  note        TEXT,
  -- discount: every listed product line of at least min_qty gets `percent` off.
  -- bundle:   only when ALL listed products are in the order (each at least its min_qty) do those lines get `percent` off.
  kind        TEXT NOT NULL CHECK (kind IN ('discount', 'bundle')),
  percent     NUMERIC(5, 2) NOT NULL CHECK (percent > 0 AND percent <= 50),
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  audience    TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'selected')),
  paused      BOOLEAN NOT NULL DEFAULT false,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX campaigns_window_idx ON campaigns (starts_at, ends_at);

CREATE TABLE campaign_products (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_qty      INTEGER NOT NULL DEFAULT 1 CHECK (min_qty >= 1),
  PRIMARY KEY (campaign_id, product_id)
);

CREATE TABLE campaign_customers (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, customer_id)
);

ALTER TABLE orders
  ADD COLUMN placed_via_app    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN app_discount_pct  NUMERIC(5, 2),
  ADD COLUMN promised_date     DATE;
CREATE INDEX orders_via_app_idx ON orders (customer_id, created_at DESC) WHERE placed_via_app;

-- A campaign line keeps the list price it started from, so "you saved" can be shown and audited.
ALTER TABLE order_items
  ADD COLUMN campaign_id   INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  ADD COLUMN list_price_amd NUMERIC;

ALTER TABLE app_settings ADD COLUMN app_orders JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Who changed the perks, linked an account or ran a campaign, and what it was before.
CREATE TABLE app_orders_log (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action  TEXT NOT NULL,
  detail  JSONB NOT NULL DEFAULT '{}'::jsonb
);
