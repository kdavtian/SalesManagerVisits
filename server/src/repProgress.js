// "Progress by reps" -- the Home progress card's drill-down: every field rep side by side for a period
// (today / this week / last week / this month, Yerevan time). Visits and check-ins, payments collected,
// orders placed (+ liters, the volume goal) and hours worked, plus the per-day hours behind the total.
import { pool } from "./db/pool.js";
import { FIELD_REP_ROLE } from "./visitCount.js";

const TZ = "Asia/Yerevan";
export const PERIODS = ["today", "week", "last_week", "month"];

// Period start/end as timestamptz, computed in Yerevan time so "today" / "Monday" match what the reps see.
const BOUNDS_SQL = {
  today: `date_trunc('day', ln)`,
  week: `date_trunc('week', ln)`,
  last_week: `date_trunc('week', ln) - interval '7 days'`,
  month: `date_trunc('month', ln)`,
};
const END_SQL = {
  today: `date_trunc('day', ln) + interval '1 day'`,
  week: `date_trunc('week', ln) + interval '7 days'`,
  last_week: `date_trunc('week', ln)`,
  month: `date_trunc('month', ln) + interval '1 month'`,
};

// Hours between the first and the last check-in of a day, rounded UP to the next 0.25 h (a single check-in = 0).
export function roundUpQuarterHours(firstMs, lastMs) {
  const hours = Math.max(0, lastMs - firstMs) / 3_600_000;
  return Math.max(0, Math.ceil(hours * 4 - 1e-9)) / 4;
}

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);

export async function computeRepProgress(period) {
  if (!PERIODS.includes(period)) throw new Error("Invalid period");
  const { rows: bounds } = await pool.query(
    `SELECT (${BOUNDS_SQL[period]}) AT TIME ZONE '${TZ}' AS from_ts,
            (${END_SQL[period]}) AT TIME ZONE '${TZ}' AS to_ts,
            to_char(${BOUNDS_SQL[period]}, 'YYYY-MM-DD') AS from_day,
            to_char((${END_SQL[period]}) - interval '1 day', 'YYYY-MM-DD') AS last_day,
            to_char(ln, 'YYYY-MM-DD') AS today
     FROM (SELECT now() AT TIME ZONE '${TZ}' AS ln) t`
  );
  const { from_ts: from, to_ts: to, from_day, last_day, today } = bounds[0];

  const [repsRes, checkinsRes, dayRes, paymentsRes, ordersRes] = await Promise.all([
    pool.query(`SELECT id AS user_id, name FROM users WHERE role = $1 ORDER BY name`, [FIELD_REP_ROLE]),
    pool.query(
      `SELECT ch.user_id, count(*)::int AS checkins, count(DISTINCT ch.customer_id)::int AS customers,
              count(DISTINCT (ch.customer_id, (ch.timestamp AT TIME ZONE '${TZ}')::date))::int AS visits
       FROM checkins ch JOIN users u ON u.id = ch.user_id AND u.role = $3
       WHERE ch.timestamp >= $1 AND ch.timestamp < $2
       GROUP BY ch.user_id`,
      [from, to, FIELD_REP_ROLE]
    ),
    pool.query(
      `SELECT ch.user_id, to_char((ch.timestamp AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day,
              min(ch.timestamp) AS first_at, max(ch.timestamp) AS last_at
       FROM checkins ch JOIN users u ON u.id = ch.user_id AND u.role = $3
       WHERE ch.timestamp >= $1 AND ch.timestamp < $2
       GROUP BY ch.user_id, (ch.timestamp AT TIME ZONE '${TZ}')::date`,
      [from, to, FIELD_REP_ROLE]
    ),
    pool.query(
      `SELECT sales_manager_id AS user_id, count(*)::int AS n, COALESCE(sum(amount_amd), 0)::float8 AS amount
       FROM payments WHERE payment_date >= $1 AND payment_date < $2 AND status <> 'rejected'
       GROUP BY sales_manager_id`,
      [from, to]
    ),
    pool.query(
      `SELECT o.user_id, count(*)::int AS n, COALESCE(sum(o.total_amd), 0)::float8 AS amount,
              COALESCE(sum((SELECT sum(oi.quantity * NULLIF(regexp_replace(p.unit, 'L$', ''), '')::numeric)
                            FROM order_items oi JOIN products p ON p.id = oi.product_id
                            WHERE oi.order_id = o.id AND p.unit ~ '^[0-9.]+L$')), 0)::float8 AS liters
       FROM orders o
       WHERE o.created_at >= $1 AND o.created_at < $2 AND o.status NOT IN ('draft', 'cancelled', 'rejected')
       GROUP BY o.user_id`,
      [from, to]
    ),
  ]);

  const by = (rows) => new Map(rows.map((r) => [r.user_id, r]));
  const checkins = by(checkinsRes.rows);
  const payments = by(paymentsRes.rows);
  const orders = by(ordersRes.rows);
  const hoursByRep = new Map();
  for (const r of dayRes.rows) {
    if (!hoursByRep.has(r.user_id)) hoursByRep.set(r.user_id, {});
    hoursByRep.get(r.user_id)[r.day] = {
      hours: roundUpQuarterHours(new Date(r.first_at).getTime(), new Date(r.last_at).getTime()),
      first_at: r.first_at,
      last_at: r.last_at,
    };
  }

  const reps = repsRes.rows.map(({ user_id, name }) => {
    const c = checkins.get(user_id) ?? { checkins: 0, customers: 0, visits: 0 };
    const p = payments.get(user_id) ?? { n: 0, amount: 0 };
    const o = orders.get(user_id) ?? { n: 0, amount: 0, liters: 0 };
    const days = hoursByRep.get(user_id) ?? {};
    const hours = Object.values(days).reduce((sum, d) => sum + d.hours, 0);
    const daysWorked = Object.keys(days).length;
    return {
      user_id,
      name,
      visits: c.visits,
      checkins: c.checkins,
      customers_visited: c.customers,
      payments_count: p.n,
      payments_amd: Math.round(p.amount),
      payments_pct_of_visits: pct(p.n, c.visits),
      orders_count: o.n,
      orders_amd: Math.round(o.amount),
      orders_pct_of_visits: pct(o.n, c.visits),
      liters: Math.round(o.liters * 10) / 10,
      hours,
      days_worked: daysWorked,
      avg_hours_per_day: daysWorked ? Math.round((hours / daysWorked) * 100) / 100 : 0,
      hours_by_day: Object.fromEntries(Object.entries(days).map(([d, v]) => [d, v.hours])),
    };
  });

  // Calendar days of the period up to today (a future day has nothing to show).
  const days = [];
  for (let d = new Date(`${from_day}T00:00:00Z`); d.toISOString().slice(0, 10) <= last_day && d.toISOString().slice(0, 10) <= today; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return { period, from_day, last_day, today, days, reps };
}
