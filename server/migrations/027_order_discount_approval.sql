-- Order-level discount + the approval gate it requires: a manager can
-- discount a client order, but a discounted order can't move past
-- "submitted" into fulfillment until a sales director (or admin) approves
-- it -- see NEXT_STATUS/discount gating in routes/orders.js.
ALTER TABLE orders ADD COLUMN discount_pct NUMERIC NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100);
ALTER TABLE orders ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'not_required'
  CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected'));
ALTER TABLE orders ADD COLUMN approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN approved_at TIMESTAMPTZ;
