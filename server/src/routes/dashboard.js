import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { seesAllActivity } from "../roles.js";

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get("/summary", async (req, res) => {
  const seesAll = seesAllActivity(req.user.role);
  const userFilter = seesAll ? "" : "AND ch.user_id = $1";
  const params = seesAll ? [] : [req.user.id];

  const totalsQuery = pool.query(
    `SELECT
       (SELECT count(*) FROM customers) AS total_customers,
       (SELECT count(DISTINCT ch.customer_id) FROM checkins ch
          WHERE ch.timestamp >= date_trunc('day', now()) ${userFilter}) AS visited_today,
       (SELECT count(DISTINCT ch.customer_id) FROM checkins ch
          WHERE ch.timestamp >= now() - interval '7 days' ${userFilter}) AS visited_this_week,
       (SELECT count(*) FROM checkins ch
          WHERE ch.timestamp >= now() - interval '7 days' ${userFilter}) AS checkins_this_week,
       (SELECT count(*) FROM checkins ch
          WHERE ch.timestamp >= date_trunc('day', now()) AND ch.within_range = false ${userFilter}) AS rejected_today,
       (SELECT count(*) FROM customers c
          WHERE NOT EXISTS (
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

  const byManagerQuery = seesAll
    ? pool.query(
        `SELECT u.id AS user_id, u.name AS user_name,
                count(ch.id) AS checkins_this_week,
                count(DISTINCT ch.customer_id) AS customers_visited_this_week
         FROM users u
         LEFT JOIN checkins ch
           ON ch.user_id = u.id AND ch.timestamp >= now() - interval '7 days'
         WHERE u.role != 'admin'
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
     )
     SELECT u.id AS user_id, u.name AS user_name,
       count(dv.*)::int AS visit_points,
       count(dv.*) FILTER (WHERE dv.has_photo)::int AS photo_points,
       (count(dv.*) + count(dv.*) FILTER (WHERE dv.has_photo))::int AS total_points
     FROM users u
     LEFT JOIN daily_visits dv ON dv.user_id = u.id
     WHERE u.role != 'admin'
     GROUP BY u.id, u.name
     ORDER BY total_points DESC, u.name`
  );

  const [totals, recentActivity, byManager, points] = await Promise.all([
    totalsQuery,
    recentActivityQuery,
    byManagerQuery,
    pointsQuery,
  ]);

  const myPoints = points.rows.find((p) => p.user_id === req.user.id) ?? {
    total_points: 0,
    visit_points: 0,
    photo_points: 0,
  };

  res.json({
    totals: totals.rows[0],
    recent_activity: recentActivity.rows,
    by_manager: byManager.rows,
    my_points: {
      total_points: myPoints.total_points,
      visit_points: myPoints.visit_points,
      photo_points: myPoints.photo_points,
    },
    points_leaderboard: seesAll ? points.rows : null,
  });
});
