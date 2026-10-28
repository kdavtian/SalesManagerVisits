import { pool } from "../db/pool.js";
import { notifyUser } from "../shared/notifications.js";
import { DELIVERY_OUTCOME_NOTIFY_ROLES } from "../shared/notificationPreferences.js";

// "Products delivered" on a check-in (owner, 2026-10-23): the rep ticks it at the customer, picks which of that
// customer's CONFIRMED / PACKED orders were handed over, and on submit those orders move to Delivered.

export const DELIVERABLE_STATUSES = ["confirmed", "packed_stock_out"];
const MAX_DELIVERED_PER_CHECKIN = 50;

// The ids the client sent (a JSON array in the multipart form), cleaned: positive integers, unique, capped.
export function parseDeliveredOrderIds(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids = parsed.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].slice(0, MAX_DELIVERED_PER_CHECKIN);
}

// The orders of one customer that can be delivered right now, oldest first (the one waiting longest is on top).
export async function deliverableOrders(customerId, db = pool) {
  const { rows } = await db.query(
    `SELECT o.id, o.order_code, o.status, o.total_amd, o.created_at, o.updated_at, u.name AS user_name,
            (SELECT COUNT(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
            (SELECT COALESCE(SUM(oi.quantity), 0)::int FROM order_items oi WHERE oi.order_id = o.id) AS unit_count
     FROM orders o JOIN users u ON u.id = o.user_id
     WHERE o.customer_id = $1 AND o.status = ANY($2)
     ORDER BY o.created_at ASC, o.id ASC`,
    [customerId, DELIVERABLE_STATUSES]
  );
  return rows.map((r) => ({ ...r, total_amd: Number(r.total_amd) }));
}

// Moves the given orders of ONE customer to Delivered, inside the caller's transaction. Only orders that are still confirmed / packed move
// (a stale pick -- already delivered, cancelled, another customer's -- is skipped, never an error). Same bookkeeping as the office's
// "mark delivered": the route stop is closed and a status-history row is written with `reason`.
export async function moveOrdersToDelivered(db, { customerId, orderIds, userId, reason }) {
  const delivered = [];
  if (!orderIds.length) return delivered;
  const { rows } = await db.query(
    `SELECT o.id, o.status, o.order_code FROM orders o
     WHERE o.id = ANY($1) AND o.customer_id = $2 AND o.status = ANY($3)
     ORDER BY o.id FOR UPDATE OF o`,
    [orderIds, customerId, DELIVERABLE_STATUSES]
  );
  for (const order of rows) {
    await db.query("UPDATE route_stops SET completed_at = now() WHERE order_id = $1 AND completed_at IS NULL", [order.id]);
    const { rowCount } = await db.query("UPDATE orders SET status = 'delivered', updated_at = now() WHERE id = $1 AND status = $2", [order.id, order.status]);
    if (!rowCount) continue;
    await db.query(
      `INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by)
       VALUES ($1, $2, 'delivered', $3, $4)`,
      [order.id, order.status, reason, userId]
    );
    delivered.push({ id: order.id, order_code: order.order_code, old_status: order.status });
  }
  return delivered;
}

// Inside the check-in's transaction: the orders the rep picked move to Delivered.
export function deliverOrdersAtCheckin(db, { customerId, orderIds, userId, checkinId }) {
  return moveOrdersToDelivered(db, { customerId, orderIds, userId, reason: `Delivered - reported on check-in #${checkinId}` });
}

// After the response: tell the people who follow deliveries (best effort, never blocks the check-in).
export function notifyCheckinDelivered({ delivered, customerName, actorId, how = "չեկ-ինում" }) {
  if (!delivered.length) return;
  (async () => {
    try {
      const { rows: actorRows } = await pool.query("SELECT name FROM users WHERE id = $1", [actorId]);
      const actorName = actorRows[0]?.name ?? "";
      const { rows: recipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [DELIVERY_OUTCOME_NOTIFY_ROLES]);
      for (const recipient of recipients) {
        if (recipient.id === actorId) continue;
        notifyUser(recipient.id, "order_delivered", {
          title: "Պատվերն առաքվեց",
          body: `${customerName}. ${actorName}-ը ${how} նշել է ${delivered.length} պատվեր որպես առաքված։`,
          url: `/#/orders?open=${delivered[0].id}`,
        });
      }
    } catch (err) {
      console.error("Post-check-in delivery notification failed:", err);
    }
  })();
}

// The orders a check-in placed and delivered, for the visit details (owner, 2026-10-27: "Products delivered" opens the delivered order like
// "Order placed" opens the placed one). A delivery is written in the order's history as "Delivered - reported on check-in #<id>"
// (deliverOrdersAtCheckin above); looked up only among that customer's orders, so the index on orders.customer_id carries it.
// Use inside a SELECT where the check-in is aliased "ch".
export const CHECKIN_ORDER_LINKS_SQL = `
  (SELECT o.id FROM orders o WHERE o.checkin_id = ch.id ORDER BY o.id DESC LIMIT 1) AS order_id,
  CASE WHEN 'customer_unavailable' = ANY(ch.outcomes) THEN
    (SELECT array_agg(DISTINCT h.order_id ORDER BY h.order_id) FROM orders o JOIN order_status_history h ON h.order_id = o.id
      WHERE o.customer_id = ch.customer_id AND h.new_status = 'delivered' AND h.reason = 'Delivered - reported on check-in #' || ch.id)
  END AS delivered_order_ids`;
