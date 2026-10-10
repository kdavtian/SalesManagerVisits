// Periodic reminder for orders sitting "packed_stock_out" too long without
// being delivered -- a batch that got packed but never made it onto (or
// off of) a route (decision C1: remind after N hours, chosen as 4). Same
// setInterval-in-the-one-process pattern as overdueReminders.js -- no job
// runner needed for a single-instance deployment. Remembers which orders
// it already nudged for so a stuck order gets at most one reminder.

import { pool } from "./db/pool.js";
import { enabled as pushEnabled } from "./push.js";
import { notifyUser } from "./notifications.js";
import { WAREHOUSE_NOTIFY_ROLES } from "./notificationPreferences.js";

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes
const STALE_HOURS = 4;
// Reminders only go out in working time (Yerevan): 09:00-17:59, Monday-Saturday.
// An order that turns stale at night is simply picked up by the first sweep of the morning.
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 18; // exclusive
const WORK_DAYS = [1, 2, 3, 4, 5, 6]; // Mon=1 ... Sun=7
const alreadyNotified = new Set(); // order_id already nudged for its current packed spell

// True during the warehouse manager's working time (Yerevan, server runs in UTC).
export function isWarehouseWorkingTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yerevan", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday")) + 1;
  const hour = Number(get("hour"));
  return WORK_DAYS.includes(dow) && hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
}

export async function checkStalePackedOrders(now = new Date()) {
  if (!pushEnabled) return;
  if (!isWarehouseWorkingTime(now)) return;

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

  // One notification for the whole batch ("5 packed orders are waiting to be
  // delivered"), not one per order; it counts every order that is stale now.
  // It goes to the warehouse manager (who holds the packed goods), not the drivers.
  const { rows: recipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [WAREHOUSE_NOTIFY_ROLES]);
  const message = buildStalePackedMessage(staleOrders);
  for (const order of staleOrders) alreadyNotified.add(order.id);
  for (const recipient of recipients) {
    await notifyUser(recipient.id, "order_stale_packed", { ...message, url: "/#/delivery" });
  }
}

// Text of the single consolidated reminder: the customer for one order, a count for several.
export function buildStalePackedMessage(staleOrders) {
  if (staleOrders.length === 1) {
    const o = staleOrders[0];
    return {
      title: "Փաթեթավորված պատվերը սպասում է",
      body: `${o.customer_name}-ի պատվերը (${o.order_code || o.id}) փաթեթավորված է ${STALE_HOURS} ժամից ավելի, բայց դեռ չի առաքվել։`,
    };
  }
  return {
    title: "Փաթեթավորված պատվերներ են սպասում",
    body: `${staleOrders.length} փաթեթավորված պատվեր սպասում է առաքման։`,
  };
}

export function startStalePackedReminder() {
  if (!pushEnabled) return;
  setInterval(() => {
    checkStalePackedOrders().catch((err) => console.error("Stale-packed reminder check failed:", err.message));
  }, CHECK_INTERVAL_MS);
}
