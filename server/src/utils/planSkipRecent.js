// "Do not plan a customer again right after a visit" (owner, 2026-10-18). A recurring route rule expands to the
// customers of that weekday; one the field team visited 1..N days BEFORE the plan date is left out of that day (the
// next route day after the window plans it again). N = app_settings.plan_skip_recent_visit_days (default 4, 0 = off),
// capped by the customer's own visit cadence (a customer visited every 2 days is not skipped for 4). A visit on the
// plan day itself never removes the customer (it stays on the list as done), and explicit one-off day plans
// (visit_plans rows, a human decision) are never filtered -- only rule expansions.
import { pool } from "../db/pool.js";
import { repVisitSql } from "../visitCount.js";

const YEREVAN_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY_MS = 86400000;

export async function getPlanSkipRecentVisitDays(db = pool) {
  const { rows } = await db.query("SELECT plan_skip_recent_visit_days FROM app_settings WHERE id = 1");
  return rows[0]?.plan_skip_recent_visit_days ?? 4;
}

export async function setPlanSkipRecentVisitDays(days) {
  const { rows } = await pool.query(
    `INSERT INTO app_settings (id, plan_skip_recent_visit_days) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET plan_skip_recent_visit_days = EXCLUDED.plan_skip_recent_visit_days
     RETURNING plan_skip_recent_visit_days`,
    [days]
  );
  return rows[0].plan_skip_recent_visit_days;
}

// Pure rule: lastVisitAt = the last field visit BEFORE `date` (a Date/ISO string or null).
export function skippedForRecentVisit({ lastVisitAt, date, windowDays, frequencyDays }) {
  if (!lastVisitAt || !(windowDays > 0)) return false;
  const lastDate = new Date(new Date(lastVisitAt).getTime() + YEREVAN_OFFSET_MS).toISOString().slice(0, 10);
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${lastDate}T00:00:00Z`)) / DAY_MS);
  const cadence = Number(frequencyDays) > 0 ? Number(frequencyDays) : windowDays;
  return diff >= 1 && diff <= Math.min(windowDays, cadence);
}

// Ids (a Set or array) of a rule-derived plan for `date`, minus the recently visited. Returns an array.
export async function dropRecentlyVisited(ids, date, { db = pool, windowDays } = {}) {
  const list = [...ids];
  if (!list.length) return list;
  const days = windowDays ?? (await getPlanSkipRecentVisitDays(db));
  if (!(days > 0)) return list;
  const { rows } = await db.query(
    `SELECT c.id, c.visit_frequency_days,
       (SELECT max(ch.timestamp) FROM checkins ch
         WHERE ch.customer_id = c.id AND ${repVisitSql("ch")}
           AND ch.timestamp < ($2::date::timestamp AT TIME ZONE 'Asia/Yerevan')) AS last_at
     FROM customers c WHERE c.id = ANY($1)`,
    [list, date]
  );
  const skip = new Set(rows.filter((r) => skippedForRecentVisit({ lastVisitAt: r.last_at, date, windowDays: days, frequencyDays: r.visit_frequency_days })).map((r) => r.id));
  return list.filter((id) => !skip.has(id));
}
