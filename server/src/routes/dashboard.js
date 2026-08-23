import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

export const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get("/summary", async (req, res) => {
  const isAdmin = req.user.role === "admin";
  const userFilter = isAdmin ? "" : "AND ch.user_id = $1";
  const params = isAdmin ? [] : [req.user.id];

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
     ${isAdmin ? "" : "WHERE ch.user_id = $1"}
     ORDER BY ch.timestamp DESC
     LIMIT 20`,
    params
  );

  const byManagerQuery = isAdmin
    ? pool.query(
        `SELECT u.id AS user_id, u.name AS user_name,
                count(ch.id) AS checkins_this_week,
                count(DISTINCT ch.customer_id) AS customers_visited_this_week
         FROM users u
         LEFT JOIN checkins ch
           ON ch.user_id = u.id AND ch.timestamp >= now() - interval '7 days'
         WHERE u.role = 'manager'
         GROUP BY u.id, u.name
         ORDER BY checkins_this_week DESC`
      )
    : Promise.resolve({ rows: null });

  const [totals, recentActivity, byManager] = await Promise.all([
    totalsQuery,
    recentActivityQuery,
    byManagerQuery,
  ]);

  res.json({
    totals: totals.rows[0],
    recent_activity: recentActivity.rows,
    by_manager: byManager.rows,
  });
});
