-- Warehouse & Delivery Module (v2). Extends the existing order status
-- machine (draft, submitted, confirmed, packed, delivered, cancelled --
-- see 041_order_draft_status.sql) rather than replacing it:
--
--   confirmed -> warehouse_review -> packed -> out_for_delivery -> delivered
--
-- with two side branches:
--   warehouse_review -> stock_issue -> confirmed  (WM flags missing stock;
--     required note; goes back to "confirmed" -- the closest existing
--     equivalent of the spec's "pending" -- so it re-enters
--     warehouse_review automatically once resolved, without needing
--     re-approval of a discount that was already signed off)
--   out_for_delivery -> returned -> confirmed  (delivery attempt failed;
--     no reason, no stock adjustment, per spec; same re-entry point)
--
-- "rejected" from the spec's context section is already covered by the
-- existing submitted -> cancelled transition, so no separate status is
-- added for it.
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN (
    'draft', 'submitted', 'confirmed', 'warehouse_review', 'stock_issue',
    'packed', 'out_for_delivery', 'delivered', 'returned', 'cancelled'
  ));

-- Required note when a Warehouse Manager flags a stock issue (kept even
-- after the order moves on, as a record of what happened).
ALTER TABLE orders ADD COLUMN stock_issue_note TEXT;

-- Per-customer credit term in days, used by the "Orders Due for Payment"
-- aging view. Defaults to 45 (per spec); NULL is treated as 45 wherever
-- it's read, but the column itself always gets a real value on insert so
-- reporting queries never need a COALESCE against a magic number.
ALTER TABLE customers ADD COLUMN credit_term_days INTEGER NOT NULL DEFAULT 45
  CHECK (credit_term_days > 0);

-- Payments switch to order-level linkage (in addition to the existing
-- customer_id, kept for backward compatibility with payments that predate
-- this feature or that aren't tied to one specific order, e.g. a lump
-- collection against several open orders at once).
ALTER TABLE payments ADD COLUMN order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL;
CREATE INDEX payments_order_id_idx ON payments (order_id);

-- Proof of Delivery. Deliberately separate from checkin_photos (see task
-- spec: "not the existing photo-capture feature") -- a POD is a delivery
-- event record (signature + a debt-balance snapshot at the moment of
-- delivery), not a visit photo, and the two must never be conflated.
-- Self-contained on purpose: every column needed to explain a given POD
-- lives on this one row, so a future archiving job is just "export the
-- row + the signature file, then delete both" with no joins required.
CREATE TABLE pod_records (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  driver_name_snapshot TEXT NOT NULL,
  signature_path TEXT NOT NULL,
  debt_balance_before_amd NUMERIC(14, 2),
  order_amount_amd NUMERIC(14, 2) NOT NULL,
  amount_collected_amd NUMERIC(14, 2) NOT NULL DEFAULT 0,
  new_balance_after_amd NUMERIC(14, 2),
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pod_records_order_id_idx ON pod_records (order_id);
CREATE INDEX pod_records_driver_id_idx ON pod_records (driver_id);

-- A delivery route is one driver's ordered stop list for a day, built by
-- the route planner (nearest-neighbor + 2-opt against OSRM, or a
-- straight-line fallback -- see server/src/osrm.js) and then hand-adjusted
-- by drag-reorder. Distinct from the existing SM "Plan day" visit-plan
-- tool (visit_plans table), which plans customer visits, not deliveries.
CREATE TABLE delivery_routes (
  id SERIAL PRIMARY KEY,
  driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  route_date DATE NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX delivery_routes_driver_date_idx ON delivery_routes (driver_id, route_date);

CREATE TABLE route_stops (
  id SERIAL PRIMARY KEY,
  route_id INTEGER NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  leg_distance_meters NUMERIC(10, 1),
  leg_duration_seconds NUMERIC(10, 1),
  completed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX route_stops_route_order_idx ON route_stops (route_id, order_id);
CREATE INDEX route_stops_order_id_idx ON route_stops (order_id);
