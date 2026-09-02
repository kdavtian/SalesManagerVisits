-- Draft orders: an order created for a customer with no ERP customer ID
-- yet lands here instead of "submitted" -- see POST /orders and
-- POST /orders/:id/submit. A draft is not visible to reviewers/fulfillment
-- and cannot be approved; it becomes "submitted" once the customer is
-- linked to an ERP record (either already was, or gets linked at submit
-- time).
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('draft', 'submitted', 'confirmed', 'packed', 'delivered', 'cancelled'));
