// Weekly scorecard per sales rep (Monday-Sunday, Yerevan dates): visits (in range only),
// customers visited, orders, how many visited customers also ordered, money collected,
// average visit length (from "End visit"), and how the debt-collection tasks went.
// Shown as a report and sent every Monday at 09:00 for the previous week.
import { pool } from "./db/pool.js";
import { notifyUser } from "./notifications.js";
import { yerevanToday } from "./utils/yerevanDate.js";

const DAY_MS = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// Monday of the week that contains `dateStr` (YYYY-MM-DD), and the next Monday.
export function weekRange(dateStr) {
  const ms = new Date(`${dateStr}T00:00:00Z`).getTime();
  const dow = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  const from = ms - dow * DAY_MS;
  return { from: iso(from), to: iso(from + 7 * DAY_MS) };
}

const D = (col) => `(${col} AT TIME ZONE 'Asia/Yerevan')::date`;

export async function buildScorecard(weekDate, { userId = null } = {}) {
  const { from, to } = weekRange(weekDate);
  const { rows } = await pool.query(
    `SELECT u.id, u.name,
       (SELECT count(*)::int FROM checkins ch WHERE ch.user_id = u.id AND ch.within_range AND ${D("ch.timestamp")} >= $1::date AND ${D("ch.timestamp")} < $2::date) AS visits,
       (SELECT count(DISTINCT ch.customer_id)::int FROM checkins ch WHERE ch.user_id = u.id AND ch.within_range AND ${D("ch.timestamp")} >= $1::date AND ${D("ch.timestamp")} < $2::date) AS customers_visited,
       (SELECT count(*)::int FROM orders o WHERE o.user_id = u.id AND o.status <> 'draft' AND ${D("o.created_at")} >= $1::date AND ${D("o.created_at")} < $2::date) AS orders,
       COALESCE((SELECT SUM(o.total_amd) FROM orders o WHERE o.user_id = u.id AND o.status <> 'draft' AND ${D("o.created_at")} >= $1::date AND ${D("o.created_at")} < $2::date), 0)::float8 AS orders_amd,
       (SELECT count(DISTINCT ch.customer_id)::int FROM checkins ch
          WHERE ch.user_id = u.id AND ch.within_range AND ${D("ch.timestamp")} >= $1::date AND ${D("ch.timestamp")} < $2::date
            AND EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.customer_id = ch.customer_id AND o.status <> 'draft'
                        AND ${D("o.created_at")} >= $1::date AND ${D("o.created_at")} < $2::date)) AS visited_and_ordered,
       COALESCE((SELECT SUM(p.amount_amd) FROM payments p WHERE p.sales_manager_id = u.id AND p.status = 'approved'
                 AND ${D("p.approved_at")} >= $1::date AND ${D("p.approved_at")} < $2::date), 0)::float8 AS collected_amd,
       (SELECT round(avg(EXTRACT(EPOCH FROM ch.ended_at - ch.timestamp) / 60))::int FROM checkins ch
          WHERE ch.user_id = u.id AND ch.ended_at IS NOT NULL AND ch.ended_at - ch.timestamp < interval '8 hours'
            AND ${D("ch.timestamp")} >= $1::date AND ${D("ch.timestamp")} < $2::date) AS avg_visit_minutes,
       (SELECT count(*)::int FROM tasks t WHERE t.assignee_id = u.id AND t.auto_kind = 'debt_collection' AND t.status = 'open') AS debt_tasks_open,
       (SELECT count(*)::int FROM tasks t WHERE t.assignee_id = u.id AND t.auto_kind = 'debt_collection' AND t.outcome IN ('paid', 'partial')
          AND ${D("t.completed_at")} >= $1::date AND ${D("t.completed_at")} < $2::date) AS debt_paid,
       (SELECT count(*)::int FROM tasks t WHERE t.assignee_id = u.id AND t.auto_kind = 'debt_collection' AND t.outcome = 'promised'
          AND ${D("t.completed_at")} >= $1::date AND ${D("t.completed_at")} < $2::date) AS debt_promised,
       (SELECT count(*)::int FROM tasks t WHERE t.assignee_id = u.id AND t.auto_kind = 'debt_collection' AND t.outcome IN ('no_answer', 'refused')
          AND ${D("t.completed_at")} >= $1::date AND ${D("t.completed_at")} < $2::date) AS debt_failed
     FROM users u WHERE u.role = 'sales_manager' AND ($3::int IS NULL OR u.id = $3)
     ORDER BY u.name`,
    [from, to, userId]
  );
  const reps = rows.map((r) => ({
    ...r,
    conversion_pct: r.customers_visited ? Math.round((r.visited_and_ordered / r.customers_visited) * 100) : null,
  }));
  return { from, to: iso(new Date(`${to}T00:00:00Z`).getTime() - DAY_MS), reps };
}

const amd = (n) => `${Math.round(n).toLocaleString("en-US")} դր.`;

// Monday 09:00+ Yerevan, once: every rep gets their own last week, management a summary.
let lastSentWeek = null;
export async function sendWeeklyScorecards(now = new Date()) {
  const today = yerevanToday(now);
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  if (dow !== 0) return 0;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yerevan", hour: "2-digit", hourCycle: "h23" }).format(now));
  if (hour < 9) return 0;
  if (lastSentWeek === today) return 0;
  const { rowCount } = await pool.query(
    "SELECT 1 FROM notifications WHERE type = 'weekly_scorecard' AND created_at >= (date_trunc('day', $1::timestamptz AT TIME ZONE 'Asia/Yerevan') AT TIME ZONE 'Asia/Yerevan') LIMIT 1",
    [now.toISOString()]
  );
  lastSentWeek = today;
  if (rowCount) return 0;

  const lastWeek = weekRange(iso(new Date(`${today}T00:00:00Z`).getTime() - DAY_MS));
  const card = await buildScorecard(lastWeek.from);
  let sent = 0;
  for (const r of card.reps) {
    const conv = r.conversion_pct === null ? "" : ` · ${r.conversion_pct}%`;
    await notifyUser(r.id, "weekly_scorecard", {
      title: "Անցած շաբաթվա արդյունքները",
      body: `Այցեր՝ ${r.visits}${conv} · պատվերներ՝ ${r.orders} (${amd(r.orders_amd)}) · հավաքագրված՝ ${amd(r.collected_amd)}`,
      url: "/#/reports?r=weekly_scorecard",
    });
    sent++;
  }
  if (card.reps.length) {
    const total = card.reps.reduce((a, r) => ({ visits: a.visits + r.visits, orders: a.orders + r.orders, amd: a.amd + r.orders_amd, col: a.col + r.collected_amd }), { visits: 0, orders: 0, amd: 0, col: 0 });
    const { rows: mgmt } = await pool.query("SELECT id FROM users WHERE role IN ('ceo', 'admin', 'sales_director', 'operations_director')");
    for (const m of mgmt) {
      await notifyUser(m.id, "weekly_scorecard", {
        title: "Թիմի շաբաթական արդյունքները",
        body: `${card.reps.length} մենեջեր · այցեր՝ ${total.visits} · պատվերներ՝ ${total.orders} (${amd(total.amd)}) · հավաքագրված՝ ${amd(total.col)}`,
        url: "/#/reports?r=weekly_scorecard",
      });
      sent++;
    }
  }
  return sent;
}
