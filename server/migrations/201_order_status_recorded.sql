-- Owner, 2026-11-11: "Recorded" becomes the final order status (after delivered). The accountant, the CEO or the admin gives it after checking the
-- order; an order the ERP sync finds in the Excel is recorded by itself. orders.recorded (the old tick) stays and is kept equal to
-- (status = 'recorded'), so the old client keeps working.
--
-- Rollback (old code reads only 'delivered'): UPDATE orders SET status = 'delivered' WHERE status = 'recorded';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('draft', 'submitted', 'confirmed', 'packed_stock_out', 'delivered', 'recorded'));

-- Existing delivered orders that were already ticked "recorded", or that the Excel already holds, become Recorded (with a timeline row).
INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by, changed_at)
SELECT id, 'delivered', 'recorded',
       CASE WHEN recorded THEN 'Recorded (the earlier Recorded tick)' ELSE 'Recorded: found in the Excel' END,
       CASE WHEN recorded THEN recorded_by END, COALESCE(recorded_at, now())
FROM orders
WHERE status = 'delivered' AND (recorded OR erp_matched_order_id IS NOT NULL OR delivered_from_erp);

UPDATE orders SET status = 'recorded', recorded = true, recorded_at = COALESCE(recorded_at, now()), not_in_excel_at = NULL
WHERE status = 'delivered' AND (recorded OR erp_matched_order_id IS NOT NULL OR delivered_from_erp);
