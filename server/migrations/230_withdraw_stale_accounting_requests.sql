-- Phase 0 item 0.17 (2026-11-28): an order the warehouse sent back to draft (stock issue) or that was cancelled kept its document request
-- "pending", so Lily could still be handed it (and it came back to her silently if the order was confirmed again). From now on those paths
-- withdraw the request in the same transaction; this withdraws the ones already left behind. Documents already made are not touched.
UPDATE orders
   SET accounting_status = 'cancelled', accounting_updated_at = now()
 WHERE accounting_status IN ('pending', 'needs_attention')
   AND (status IN ('draft', 'submitted') OR cancelled_at IS NOT NULL);
