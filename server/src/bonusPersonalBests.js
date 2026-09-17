// Personal bests (bonus_personal_bests -- migrations/076_bonuses_schema.sql):
// "Highest confirmed full-calendar-week collectible count/points" per the
// brief's "Exclude incomplete historical coverage" -- only ever computed
// for a week that has already fully ended, never the week in progress (an
// in-progress week's partial total could never fairly compete with a past
// full week's total, and would keep changing underneath a displayed
// "personal best" as the week continues).
import { pool } from "./db/pool.js";
import { yerevanWeekBounds } from "./utils/yerevanDate.js";

// Recomputes every user's totals for one completed week and raises their
// personal best if this week beat it -- GREATEST() in the UPSERT means a
// re-run (the worker calls this every tick) can only ever hold a best
// steady or raise it, never lower one a later, smaller week's recompute
// might otherwise imply.
export async function updatePersonalBestsForWeek(weekStartAt, weekEndAt) {
  const { rows } = await pool.query(
    `SELECT user_id, SUM(collectible_delta_scaled) AS collectible_total, SUM(points_delta_scaled) AS points_total
     FROM bonus_point_ledger
     WHERE created_at >= $1 AND created_at < $2
     GROUP BY user_id`,
    [weekStartAt, weekEndAt]
  );
  const weekStartDate = weekStartAt.toISOString().slice(0, 10);
  let updated = 0;
  for (const row of rows) {
    const collectibleTotal = Math.max(0, Number(row.collectible_total));
    const pointsTotal = Math.max(0, Number(row.points_total));
    await pool.query(
      `INSERT INTO bonus_personal_bests (user_id, metric, best_value_scaled, achieved_week_start)
       VALUES ($1, 'collectible_count', $2, $3)
       ON CONFLICT (user_id, metric) DO UPDATE SET
         best_value_scaled = GREATEST(bonus_personal_bests.best_value_scaled, EXCLUDED.best_value_scaled),
         achieved_week_start = CASE WHEN EXCLUDED.best_value_scaled > bonus_personal_bests.best_value_scaled THEN EXCLUDED.achieved_week_start ELSE bonus_personal_bests.achieved_week_start END,
         updated_at = now()`,
      [row.user_id, collectibleTotal, weekStartDate]
    );
    await pool.query(
      `INSERT INTO bonus_personal_bests (user_id, metric, best_value_scaled, achieved_week_start)
       VALUES ($1, 'points', $2, $3)
       ON CONFLICT (user_id, metric) DO UPDATE SET
         best_value_scaled = GREATEST(bonus_personal_bests.best_value_scaled, EXCLUDED.best_value_scaled),
         achieved_week_start = CASE WHEN EXCLUDED.best_value_scaled > bonus_personal_bests.best_value_scaled THEN EXCLUDED.achieved_week_start ELSE bonus_personal_bests.achieved_week_start END,
         updated_at = now()`,
      [row.user_id, pointsTotal, weekStartDate]
    );
    updated += 1;
  }
  return { usersUpdated: updated };
}

// The most recently *completed* week as of `now` -- last week's bounds,
// never this week's (see this file's own header).
export function lastCompletedWeekBounds(now = new Date()) {
  const thisWeek = yerevanWeekBounds(now);
  const lastWeekReference = new Date(thisWeek.startAt.getTime() - 24 * 60 * 60 * 1000);
  return yerevanWeekBounds(lastWeekReference);
}

export async function listPersonalBestsForUser(userId) {
  const { rows } = await pool.query("SELECT metric, best_value_scaled, achieved_week_start FROM bonus_personal_bests WHERE user_id = $1", [
    userId,
  ]);
  return rows;
}
