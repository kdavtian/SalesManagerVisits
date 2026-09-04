// Periodic reminder for orders sitting "packed_stock_out" too long without
// being delivered -- a batch that got packed but never made it onto (or
// off of) a route (decision C1: remind after N hours, chosen as 4). Same
// setInterval-in-the-one-process pattern as overdueReminders.js -- no job
// runner needed for a single-instance deployment. Remembers which orders
// it already nudged for so a stuck order gets at most one reminder.

import { pool } from "./db/pool.js";
import { enabled as pushEnabled } from "./push.js";
import { notifyUser } from "./notifications.js";
import { DRIVER_NOTIFY_ROLES } from "./notificationPreferences.js";

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes
const STALE_HOURS = 4;
const alreadyNotified = new Set(); // order_id already nudged for its current packed spell

export async function checkStalePackedOrders() {
  if (!pushEnabled) return;

  const { rows: staleOrders } = await pool.query(
    `SELECT o.id, o.order_code, c.name AS customer_name
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     WHERE o.status = 'packed_stock_out' AND o.updated_at < now() - ($1 || ' hours')::interval`,
    [STALE_HOURS]
  );

  const staleIds = new Set(staleOrders.map((o) => o.id));
  // Forget orders that are no longer stale (delivered, sent back to draft,
  // or re-packed since) so a future stale spell can notify again.
  for (const id of alreadyNotified) {
    if (!staleIds.has(id)) alreadyNotified.delete(id);
  }

  const toNotify = staleOrders.filter((o) => !alreadyNotified.has(o.id));
  if (!toNotify.length) return;

  const { rows: recipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [DRIVER_NOTIFY_ROLES]);
  for (const order of toNotify) {
    alreadyNotified.add(order.id);
    for (const recipient of recipients) {
      await notifyUser(recipient.id, "order_stale_packed", {
        title: "Packed order waiting",
        body: `${order.customer_name}'s order (${order.order_code || order.id}) has been packed for over ${STALE_HOURS}h without being delivered.`,
        url: "/#/delivery",
      });
    }
  }
}

export function startStalePackedReminder() {
  if (!pushEnabled) return;
  setInterval(() => {
    checkStalePackedOrders().catch((err) => console.error("Stale-packed reminder check failed:", err.message));
  }, CHECK_INTERVAL_MS);
}
