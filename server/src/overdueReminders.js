// Periodic "you still have unvisited planned stops today" push reminder.
// There's no job runner in this app (see dashboard.js's monthly close-out
// comment) and this doesn't need one -- a plain setInterval inside the one
// long-running Node process is enough for a single-instance deployment.
// Runs a few times a day rather than continuously, and remembers who it
// already nudged today so a rep gets at most one reminder per day.

import { pool } from "./db/pool.js";
import { notifyUser, enabled as pushEnabled } from "./push.js";

const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000; // every 2 hours
const lastNotifiedDate = new Map(); // user_id -> "YYYY-MM-DD" already notified

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export async function checkOverdueReminders() {
  if (!pushEnabled) return;

  const today = todayKey();
  const { rows: plans } = await pool.query(
    `SELECT user_id, customer_ids FROM visit_plans WHERE plan_date = current_date AND status = 'approved'`
  );

  for (const plan of plans) {
    if (lastNotifiedDate.get(plan.user_id) === today) continue;
    if (!plan.customer_ids?.length) continue;

    const { rows: visitedRows } = await pool.query(
      `SELECT DISTINCT customer_id FROM checkins
       WHERE user_id = $1 AND customer_id = ANY($2) AND timestamp >= date_trunc('day', now())`,
      [plan.user_id, plan.customer_ids]
    );
    const visited = new Set(visitedRows.map((r) => r.customer_id));
    const remaining = plan.customer_ids.filter((id) => !visited.has(id));
    if (!remaining.length) continue;

    lastNotifiedDate.set(plan.user_id, today);
    await notifyUser(plan.user_id, {
      title: "Planned visits waiting",
      body: `You still have ${remaining.length} planned stop${remaining.length === 1 ? "" : "s"} to visit today.`,
      url: "/#/map",
    });
  }
}

export function startOverdueReminders() {
  if (!pushEnabled) return;
  setInterval(() => {
    checkOverdueReminders().catch((err) => console.error("Overdue reminder check failed:", err.message));
  }, CHECK_INTERVAL_MS);
}
