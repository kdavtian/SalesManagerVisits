// Once-a-day digest of everything sitting unresolved across the app --
// orders awaiting action, payments awaiting approval, and customers overdue
// for a field visit -- pushed to management so nothing quietly piles up
// between the per-event notifications (order_status_changed, payment_due_soon,
// etc.), which only fire on a state *change*, not on "still stuck".
//
// Same setInterval-in-the-one-process pattern as overdueReminders.js/
// stalePackedReminder.js/erpSyncMonitor.js -- no job runner needed for a
// single-instance deployment. Checks periodically but only actually sends
// once per calendar day (server-local date), remembered in-process.

import { pool } from "./db/pool.js";
import { enabled as pushEnabled } from "./push.js";
import { notifyUser } from "./notifications.js";
import { NOT_NO_VISIT_CHANNEL_SQL } from "./routes/customers.js";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly; only actually sends once the target hour has passed for the day
const SUMMARY_HOUR_UTC = 6; // ~10am Yerevan (UTC+4) -- once the day's field work has started

const SUMMARY_RECIPIENT_ROLES = ["admin", "ceo", "sales_director", "accountant"];

let lastSentDate = null; // "YYYY-MM-DD" the summary was last sent for

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function countUnresolvedOrders() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM orders WHERE status IN ('submitted', 'confirmed', 'packed_stock_out')`
  );
  return rows[0].count;
}

async function countPendingPayments() {
  const { rows } = await pool.query(`SELECT count(*)::int AS count FROM payments WHERE status = 'pending'`);
  return rows[0].count;
}

async function countOverdueCustomers() {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM customers c
     WHERE ${NOT_NO_VISIT_CHANNEL_SQL}
       AND NOT EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= date_trunc('day', now()))
       AND (
         (SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id) IS NULL
         OR (SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id) < now() - (c.visit_frequency_days || ' days')::interval
       )`
  );
  return rows[0].count;
}

export async function buildDailySummary() {
  const [unresolvedOrders, pendingPayments, overdueCustomers] = await Promise.all([
    countUnresolvedOrders(),
    countPendingPayments(),
    countOverdueCustomers(),
  ]);
  return { unresolvedOrders, pendingPayments, overdueCustomers };
}

export async function checkDailySummary(now = new Date()) {
  if (!pushEnabled) return;
  if (now.getUTCHours() < SUMMARY_HOUR_UTC) return;

  const today = todayKey();
  if (lastSentDate === today) return;

  const summary = await buildDailySummary();
  if (!summary.unresolvedOrders && !summary.pendingPayments && !summary.overdueCustomers) {
    lastSentDate = today;
    return;
  }

  const { rows: recipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [SUMMARY_RECIPIENT_ROLES]);
  lastSentDate = today;

  for (const recipient of recipients) {
    await notifyUser(recipient.id, "daily_summary", {
      title: "Օրվա ամփոփում",
      body: `Չլուծված պատվերներ՝ ${summary.unresolvedOrders}, սպասող վճարումներ՝ ${summary.pendingPayments}, ուշացած այցելություններ՝ ${summary.overdueCustomers}։`,
      url: "/#/dashboard",
    });
  }
}

export function startDailySummary() {
  if (!pushEnabled) return;
  setInterval(() => {
    checkDailySummary().catch((err) => console.error("Daily summary check failed:", err.message));
  }, CHECK_INTERVAL_MS);
}
