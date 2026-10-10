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

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes; only sends inside the 7 pm window, once a day
// The summary goes out once a day at 19:00 Yerevan time (the check that lands
// in the 19:00 hour sends it; a restart later that evening still catches up,
// but never after 22:00).
const SUMMARY_HOUR = 19;
const SUMMARY_LAST_HOUR = 21;

const SUMMARY_RECIPIENT_ROLES = ["admin", "ceo", "operations_director", "sales_director", "accountant"];

let lastSentDate = null; // Yerevan "YYYY-MM-DD" the summary was last sent (or skipped as empty) for

// Yerevan calendar date and hour of an instant (the server runs in UTC).
function yerevanParts(now) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yerevan", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

// True while the 7 pm send window is open (19:00-21:59 Yerevan).
export function isSummaryWindow(now = new Date()) {
  const { hour } = yerevanParts(now);
  return hour >= SUMMARY_HOUR && hour <= SUMMARY_LAST_HOUR;
}

// The day key used to send at most once per day.
export function summaryDayKey(now = new Date()) {
  return yerevanParts(now).day;
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
       AND NOT EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.within_range AND ch.timestamp >= date_trunc('day', now()))
       AND (
         (SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id AND ch.within_range) IS NULL
         OR (SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id AND ch.within_range) < now() - (c.visit_frequency_days || ' days')::interval
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
  if (!isSummaryWindow(now)) return;

  const today = summaryDayKey(now);
  if (lastSentDate === today) return;
  // Survives a restart: if someone already got today's summary, don't send it again.
  const { rowCount: alreadySent } = await pool.query(
    "SELECT 1 FROM notifications WHERE type = 'daily_summary' AND created_at >= (date_trunc('day', $1::timestamptz AT TIME ZONE 'Asia/Yerevan') AT TIME ZONE 'Asia/Yerevan') LIMIT 1",
    [now.toISOString()]
  );
  if (alreadySent) {
    lastSentDate = today;
    return;
  }

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
