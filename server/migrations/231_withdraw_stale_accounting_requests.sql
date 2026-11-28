-- Phase 0 item 0.17 (2026-11-28): an order the warehouse sent back to draft (stock issue) or that was cancelled kept its document request
-- "pending", so Lily could still be handed it (and it came back to her silently if the order was confirmed again). From now on those paths
-- withdraw the request in the same transaction; this withdraws the ones already left behind. A request that has documents is not touched
-- (a person deals with it).
UPDATE orders
   SET accounting_status = 'cancelled', accounting_updated_at = now()
 WHERE accounting_status IN ('pending', 'needs_attention')
   AND COALESCE(jsonb_array_length(accounting_documents), 0) = 0
   AND (status IN ('draft', 'submitted') OR cancelled_at IS NOT NULL);
