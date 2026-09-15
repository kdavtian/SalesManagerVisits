-- payment_status_history and order_status_history are append-only audit
-- logs by design (the application code only ever INSERTs into them, never
-- UPDATEs a row after the fact) -- but nothing before this enforced that
-- at the database level, so a bug, a future contributor unfamiliar with
-- that convention, or direct DB access could silently rewrite financial
-- history. This trigger makes it a hard guarantee instead of a
-- convention: any UPDATE against either table is rejected outright.
--
-- DELETE is deliberately left alone, not blocked: order_status_history has
-- ON DELETE CASCADE from orders(id), and orders.js's admin-only DELETE
-- /orders/:id relies on that cascade to clean up a deleted order's own
-- history along with it -- blocking DELETE here would break that already-
-- privileged, already-legitimate operation. What this guards against is
-- someone editing a history row's content to say something different
-- happened, not an authorized admin purging an order (and its trail)
-- entirely.
CREATE FUNCTION reject_audit_log_modification() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is an immutable audit log -- % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_status_history_immutable
  BEFORE UPDATE ON payment_status_history
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_modification();

CREATE TRIGGER order_status_history_immutable
  BEFORE UPDATE ON order_status_history
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_modification();
