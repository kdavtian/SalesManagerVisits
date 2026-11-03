// Once a week (Sunday evening Yerevan time, so the CEO sees it on Monday morning) Vaghinak analyses the route plans and tells the CEO / admin when
// there is something to decide. Nothing in any plan changes here: the suggestions wait for an accept (routes/routePlanSuggestions.js).
import { pool } from "../db/pool.js";
import { yerevanToday, yerevanTimeOfDay, yerevanIsoDayOfWeek } from "../utils/yerevanDate.js";
import { getVaghinakSettings } from "../team/vaghinak/settings.js";
import { runRoutePlanAnalysis, notifyReviewers } from "./routePlanAnalysis.js";

const SUNDAY = 7;
const FROM_MINUTE = 18 * 60;

export async function runWeeklyRoutePlanAnalysis(now = new Date(), db = pool) {
  if (yerevanIsoDayOfWeek(now) !== SUNDAY) return { skipped: "not_sunday" };
  const t = yerevanTimeOfDay(now);
  const minute = typeof t === "number" ? t : Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
  if (minute < FROM_MINUTE) return { skipped: "too_early" };
  if ((await getVaghinakSettings(db)).mode === "off") return { skipped: "vaghinak_off" };
  const { rows } = await db.query("SELECT 1 FROM route_plan_suggestions WHERE (created_at AT TIME ZONE 'Asia/Yerevan')::date = $1::date LIMIT 1", [yerevanToday(now)]);
  if (rows.length) return { skipped: "done_today" };
  const result = await runRoutePlanAnalysis(db);
  await notifyReviewers(result.created, db);
  return result;
}
