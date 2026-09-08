import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { seesAllActivity } from "../roles.js";
import { notifyTelegram, escapeHtml } from "../telegram.js";
import { NOT_NO_VISIT_CHANNEL_SQL } from "./customers.js";
import { batchExpandAreas } from "./visitPlans.js";

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

// Monday of the current week through today, inclusive, as YYYY-MM-DD
// strings -- the window the progress card's "Today's progress" figure
// actually sums over (see computeWeekProgress below). Monday-start to
// match Postgres's own date_trunc('week', ...), which the visited-count
// half of that figure is computed with.
function weekDatesToToday() {
  const now = new Date();
  const utcDay = now.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = utcDay === 0 ? 6 : utcDay - 1;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - daysSinceMonday);
  const dates = [];
  for (let i = 0; i <= daysSinceMonday; i++) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// The progress card's big "Today's progress" fraction is actually a
// running week-to-date total, not a single day's numbers -- on Monday it's
// just Monday's planned-vs-visited, but by Friday it's the sum of every
// planned/visited count from Monday through Friday. Mirrors GET
// /visit-plans/mine's own "persisted row wins, else synthesize from an
// active recurring rule" resolution, just batched across every date in the
// window (and every target user, for the company-wide roles) instead of
// one date/user per request -- same batching idea as the Route Plans
// overview endpoint (see batchExpandAreas).
async function computeWeekProgress(targetUserIds) {
  if (!targetUserIds.length) return { planned_to_date: 0, visited_to_date: 0 };
  const dates = weekDatesToToday();

  const { rows: persisted } = await pool.query(
    `SELECT user_id, plan_date::text AS plan_date, customer_ids, status
     FROM visit_plans
     WHERE user_id = ANY($1) AND plan_date = ANY($2::date[])`,
    [targetUserIds, dates]
  );
  const persistedByKey = new Map(persisted.map((r) => [`${r.user_id}:${r.plan_date}`, r]));

  const { rows: rules } = await pool.query(
    "SELECT * FROM visit_plan_rules WHERE user_id = ANY($1) AND active",
    [targetUserIds]
  );
  const areaIdsByRule = await batchExpandAreas(rules);
  const ruleByUserDay = new Map(rules.map((r) => [`${r.user_id}:${r.day_of_week}`, r]));

  let plannedToDate = 0;
  for (const userId of targetUserIds) {
    for (const date of dates) {
      const persistedRow = persistedByKey.get(`${userId}:${date}`);
      if (persistedRow) {
        if (persistedRow.status === "approved") plannedToDate += (persistedRow.customer_ids ?? []).length;
        continue;
      }
      const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
      const rule = ruleByUserDay.get(`${userId}:${dayOfWeek}`);
      if (!rule) continue;
      const areaIds = areaIdsByRule.get(rule.id) ?? new Set();
      const customerIds = new Set([...areaIds, ...(rule.customer_ids ?? [])]);
      plannedToDate += customerIds.size;
    }
  }

  // Per-day distinct customer counts, summed -- not one distinct-across-
  // the-week count, so a customer visited on two different days this week
  // still contributes to both of those days' totals (matching how each
  // day's own planned count is a separate figure too).
  const { rows: visitedRows } = await pool.query(
    `SELECT count(DISTINCT ch.customer_id)::int AS visited
     FROM checkins ch
     WHERE ch.user_id = ANY($1) AND ch.timestamp >= date_trunc('week', now())
     GROUP BY date_trunc('day', ch.timestamp)`,
    [targetUserIds]
  );
  const visitedToDate = visitedRows.reduce((sum, r) => sum + r.visited, 0);

  return { planned_to_date: plannedToDate, visited_to_date: visitedToDate };
}

dashboardRouter.get("/summary", async (req, res) => {
  const seesAll = seesAllActivity(req.user.role);
  const userFilter = seesAll ? "" : "AND ch.user_id = $1";
  // Same $1 (the viewer's own id) as userFilter above, just against the
  // customer's owning manager instead of the checkin's actor -- keeps a
  // sales_manager's "total customers" and "overdue" counts scoped to their
  // own book, matching every other number on this same progress card
  // (previously these two ran unscoped for every role, always counting the
  // whole company's customers regardless of who was viewing).
  const customerFilter = seesAll ? "" : "AND c.assigned_manager_id = $1";
  const params = seesAll ? [] : [req.user.id];

  const totalsQuery = pool.query(
    `SELECT
       -- Scoped to customers that actually get field visits (see
       -- NOT_NO_VISIT_CHANNEL_SQL) -- this is the denominator for the
       -- progress card's "X/Y" and "remaining" figures, so it needs to
       -- match what "overdue" already excludes below. Counting every
       -- customer here (including KF/CAS/CVO/PCO/OEM, which are never
       -- visited in the field) made "remaining" overstate how many
       -- customers were actually still to be visited that day.
       (SELECT count(*) FROM customers c WHERE ${NOT_NO_VISIT_CHANNEL_SQL} ${customerFilter}) AS total_customers,
       (SELECT count(DISTINCT ch.customer_id) FROM checkins ch
          WHERE ch.timestamp >= date_trunc('day', now()) ${userFilter}) AS visited_today,
       (SELECT count(DISTINCT ch.customer_id) FROM checkins ch
          WHERE ch.timestamp >= date_trunc('week', now()) ${userFilter}) AS visited_this_week,
       (SELECT count(*) FROM checkins ch
          WHERE ch.timestamp >= date_trunc('week', now()) ${userFilter}) AS checkins_this_week,
       (SELECT count(*) FROM checkins ch
          WHERE ch.timestamp >= date_trunc('day', now()) AND ch.within_range = false ${userFilter}) AS rejected_today,
       (SELECT count(*) FROM customers c
          WHERE ${NOT_NO_VISIT_CHANNEL_SQL}
          ${customerFilter}
          AND NOT EXISTS (
            SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= date_trunc('day', now())
          )
          AND (
            (SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id) IS NULL
            OR (SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id)
               < now() - (c.visit_frequency_days || ' days')::interval
          )) AS overdue`,
    params
  );

  const recentActivityQuery = pool.query(
    `SELECT ch.id, ch.timestamp, ch.within_range, ch.distance_meters, ch.note,
            u.name AS user_name, c.name AS customer_name, c.id AS customer_id
     FROM checkins ch
     JOIN users u ON u.id = ch.user_id
     JOIN customers c ON c.id = ch.customer_id
     ${seesAll ? "" : "WHERE ch.user_id = $1"}
     ORDER BY ch.timestamp DESC
     LIMIT 20`,
    params
  );

  // Per-manager breakdown for the consolidated Director/Admin/CEO/Accountant
  // dashboard's drill-down (item 5) -- each row carries the same three
  // "progress card" numbers as the single-manager totals above
  // (total_customers/visited_today/overdue), scoped to that one manager via
  // a correlated subquery on u.id, plus the pre-existing this-week figures.
  const byManagerQuery = seesAll
    ? pool.query(
        `SELECT u.id AS user_id, u.name AS user_name,
                count(ch.id) AS checkins_this_week,
                count(DISTINCT ch.customer_id) AS customers_visited_this_week,
                (SELECT count(*) FROM customers c WHERE c.assigned_manager_id = u.id AND ${NOT_NO_VISIT_CHANNEL_SQL}) AS total_customers,
                (SELECT count(DISTINCT ch2.customer_id) FROM checkins ch2
                   WHERE ch2.user_id = u.id AND ch2.timestamp >= date_trunc('day', now())) AS visited_today,
                (SELECT count(*) FROM customers c
                   WHERE c.assigned_manager_id = u.id
                   AND ${NOT_NO_VISIT_CHANNEL_SQL}
                   AND NOT EXISTS (
                     SELECT 1 FROM checkins ch3 WHERE ch3.customer_id = c.id AND ch3.timestamp >= date_trunc('day', now())
                   )
                   AND (
                     (SELECT max(ch4.timestamp) FROM checkins ch4 WHERE ch4.customer_id = c.id) IS NULL
                     OR (SELECT max(ch4.timestamp) FROM checkins ch4 WHERE ch4.customer_id = c.id)
                        < now() - (c.visit_frequency_days || ' days')::interval
                   )) AS overdue
         FROM users u
         LEFT JOIN checkins ch
           ON ch.user_id = u.id AND ch.timestamp >= date_trunc('week', now())
         -- Sales managers only: this breakdown measures progress against an
         -- assigned customer book, and accountants/drivers/warehouse and
         -- delivery managers don't have one -- their rows were always
         -- 0/0/0 noise that pushed the real reps down the list.
         WHERE u.role = 'sales_manager'
         GROUP BY u.id, u.name
         ORDER BY checkins_this_week DESC`
      )
    : Promise.resolve({ rows: null });

  // Points: 1 per customer actually visited that day (repeat visits to the
  // same customer on the same day don't stack), +1 more if that day's
  // visit(s) to that customer included a photo. Derived straight from
  // checkins/checkin_photos rather than a separate ledger, so it can never
  // drift out of sync with the real visit history.
  const pointsQuery = pool.query(
    `WITH daily_visits AS (
       SELECT ch.user_id, ch.customer_id, date_trunc('day', ch.timestamp) AS visit_day,
              bool_or(ch.photo_path IS NOT NULL OR EXISTS (SELECT 1 FROM checkin_photos cp WHERE cp.checkin_id = ch.id)) AS has_photo
       FROM checkins ch
       WHERE ch.timestamp >= date_trunc('month', now())
       GROUP BY ch.user_id, ch.customer_id, date_trunc('day', ch.timestamp)
     ),
     new_customers AS (
       SELECT c.created_by AS user_id, count(*)::int AS customer_points
       FROM customers c
       WHERE c.created_at >= date_trunc('month', now())
       GROUP BY c.created_by
     )
     SELECT u.id AS user_id, u.name AS user_name,
       count(dv.*)::int AS visit_points,
       count(dv.*) FILTER (WHERE dv.has_photo)::int AS photo_points,
       coalesce(nc.customer_points, 0) AS customer_points,
       (count(dv.*) + count(dv.*) FILTER (WHERE dv.has_photo) + coalesce(nc.customer_points, 0))::int AS total_points
     FROM users u
     LEFT JOIN daily_visits dv ON dv.user_id = u.id
     LEFT JOIN new_customers nc ON nc.user_id = u.id
     -- The monthly premium is a sales-rep competition, so the standings
     -- list sales managers and nobody else. Excluding only 'admin' let
     -- accountants/drivers/warehouse+delivery managers/directors/CEO onto
     -- a board they aren't competing on. Kept identical to
     -- computeMonthlyStandings() below -- a close-out that ranked a
     -- different population than the live board would be a nasty surprise
     -- on payout day.
     WHERE u.role = 'sales_manager'
     GROUP BY u.id, u.name, nc.customer_points
     ORDER BY total_points DESC, u.name`
  );

  // Company-wide roles get the whole team's week-to-date figure (matching
  // the by_manager breakdown below); everyone else gets just their own --
  // same population as /users/plannable (sales managers are the only role
  // that ever has a visit plan).
  const weekProgressQuery = (seesAll ? pool.query("SELECT id FROM users WHERE role = 'sales_manager'") : Promise.resolve({ rows: [{ id: req.user.id }] }))
    .then((r) => computeWeekProgress(r.rows.map((row) => row.id)));

  const [totals, recentActivity, byManager, points, weekProgress] = await Promise.all([
    totalsQuery,
    recentActivityQuery,
    byManagerQuery,
    pointsQuery,
    weekProgressQuery,
  ]);

  const myPoints = points.rows.find((p) => p.user_id === req.user.id) ?? {
    total_points: 0,
    visit_points: 0,
    photo_points: 0,
    customer_points: 0,
  };

  res.json({
    totals: { ...totals.rows[0], ...weekProgress },
    recent_activity: recentActivity.rows,
    by_manager: byManager.rows,
    my_points: {
      total_points: myPoints.total_points,
      visit_points: myPoints.visit_points,
      photo_points: myPoints.photo_points,
      customer_points: myPoints.customer_points,
    },
    // Every role can *see* the board (management wants the standings too),
    // but only sales managers appear *on* it -- they're the ones competing
    // for the monthly premium (see pointsQuery's role filter above).
    points_leaderboard: points.rows,
  });
});

// 30-day daily visit trend + week/month-over-week/month comparisons, for
// the dashboard's trend chart. Same user-scoping as /summary: a rep sees
// only their own activity, a director/admin/CEO sees the whole org.
dashboardRouter.get("/trends", async (req, res) => {
  const seesAll = seesAllActivity(req.user.role);
  const userFilter = seesAll ? "" : "AND ch.user_id = $1";
  const params = seesAll ? [] : [req.user.id];

  const dailyQuery = pool.query(
    `SELECT date_trunc('day', ch.timestamp)::date AS day, count(*)::int AS visits
     FROM checkins ch
     WHERE ch.timestamp >= now() - interval '29 days' ${userFilter}
     GROUP BY day
     ORDER BY day`,
    params
  );

  const comparisonQuery = pool.query(
    `SELECT
       (SELECT count(*) FROM checkins ch WHERE ch.timestamp >= date_trunc('week', now()) ${userFilter}) AS this_week,
       (SELECT count(*) FROM checkins ch WHERE ch.timestamp >= date_trunc('week', now() - interval '7 days')
          AND ch.timestamp < date_trunc('week', now()) ${userFilter}) AS last_week,
       (SELECT count(*) FROM checkins ch WHERE ch.timestamp >= date_trunc('month', now()) ${userFilter}) AS this_month,
       (SELECT count(*) FROM checkins ch WHERE ch.timestamp >= date_trunc('month', now() - interval '1 month')
          AND ch.timestamp < date_trunc('month', now()) ${userFilter}) AS last_month`,
    params
  );

  const [daily, comparison] = await Promise.all([dailyQuery, comparisonQuery]);

  // Fill in the days with zero visits -- the query above only returns rows
  // that exist, so the chart would otherwise show gaps as "no data" instead
  // of a flat zero.
  const byDay = new Map(daily.rows.map((r) => [r.day.toISOString().slice(0, 10), r.visits]));
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    series.push({ day: key, visits: byDay.get(key) ?? 0 });
  }

  res.json({ daily: series, comparison: comparison.rows[0] });
});

function isValidMonthString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-01$/.test(value);
}

// Same visit/photo point rule as the live dashboard query above, but scoped
// to one specific calendar month instead of "since the start of this
// month" -- needed to close out a month after it's already ended.
async function computeMonthlyStandings(month) {
  const { rows } = await pool.query(
    `WITH daily_visits AS (
       SELECT ch.user_id, ch.customer_id, date_trunc('day', ch.timestamp) AS visit_day,
              bool_or(ch.photo_path IS NOT NULL OR EXISTS (SELECT 1 FROM checkin_photos cp WHERE cp.checkin_id = ch.id)) AS has_photo
       FROM checkins ch
       WHERE ch.timestamp >= $1::date AND ch.timestamp < ($1::date + interval '1 month')
       GROUP BY ch.user_id, ch.customer_id, date_trunc('day', ch.timestamp)
     ),
     new_customers AS (
       SELECT c.created_by AS user_id, count(*)::int AS customer_points
       FROM customers c
       WHERE c.created_at >= $1::date AND c.created_at < ($1::date + interval '1 month')
       GROUP BY c.created_by
     )
     SELECT u.id AS user_id, u.name AS user_name,
       count(dv.*)::int AS visit_points,
       count(dv.*) FILTER (WHERE dv.has_photo)::int AS photo_points,
       coalesce(nc.customer_points, 0) AS customer_points,
       (count(dv.*) + count(dv.*) FILTER (WHERE dv.has_photo) + coalesce(nc.customer_points, 0))::int AS total_points
     FROM users u
     LEFT JOIN daily_visits dv ON dv.user_id = u.id
     LEFT JOIN new_customers nc ON nc.user_id = u.id
     -- Same population as the live leaderboard in /summary above.
     WHERE u.role = 'sales_manager'
     GROUP BY u.id, u.name, nc.customer_points
     ORDER BY total_points DESC, u.name`,
    [month]
  );
  return rows;
}

// Admin-triggered, not scheduled -- there's no job runner in this app, and
// closing out a month is the kind of thing someone should actually decide
// to do (right before paying out the bonus), not something that silently
// fires itself.
dashboardRouter.post("/points/close-out", requireAdmin, async (req, res) => {
  const { month } = req.body ?? {};
  if (!isValidMonthString(month)) {
    return res.status(400).json({ error: "month must be YYYY-MM-01" });
  }

  const standings = await computeMonthlyStandings(month);
  if (!standings.length) return res.json([]);

  const client = await pool.connect();
  let saved;
  try {
    await client.query("BEGIN");
    saved = [];
    for (let i = 0; i < standings.length; i++) {
      const s = standings[i];
      const { rows } = await client.query(
        `INSERT INTO monthly_points_closeouts
           (month, user_id, user_name, total_points, visit_points, photo_points, customer_points, rank, closed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (month, user_id) DO UPDATE
           SET user_name = EXCLUDED.user_name, total_points = EXCLUDED.total_points,
               visit_points = EXCLUDED.visit_points, photo_points = EXCLUDED.photo_points,
               customer_points = EXCLUDED.customer_points,
               rank = EXCLUDED.rank, closed_by = EXCLUDED.closed_by, closed_at = now()
         RETURNING *`,
        [
          month,
          s.user_id,
          s.user_name,
          s.total_points,
          s.visit_points,
          s.photo_points,
          s.customer_points,
          i + 1,
          req.user.id,
        ]
      );
      saved.push(rows[0]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json(saved);

  try {
    const winner = saved.find((s) => s.rank === 1);
    if (winner) {
      notifyTelegram(
        `🏆 <b>${month.slice(0, 7)} points winner</b>\n${escapeHtml(winner.user_name)} — ${winner.total_points} pts`
      );
    }
  } catch (err) {
    console.error("Post-closeout notification failed:", err);
  }
});

// Anyone who already sees the live leaderboard can browse past close-outs.
dashboardRouter.get("/points/closeouts", async (req, res) => {
  if (!seesAllActivity(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { month } = req.query;
  const { rows } = await pool.query(
    isValidMonthString(month)
      ? { text: "SELECT * FROM monthly_points_closeouts WHERE month = $1 ORDER BY rank", values: [month] }
      : { text: "SELECT * FROM monthly_points_closeouts ORDER BY month DESC, rank", values: [] }
  );
  res.json(rows);
});
