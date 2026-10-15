// MONDAY DIGEST (V2): on the first working morning of the week (from 09:00) every rep gets a short, warm look back at
// last week -- plan completion, late starts (silently logged all week, mentioned once, gently) -- and management gets
// one summary with the people who need a talk. Facts come only from vaghinak_day_log (no new data is collected).
// One message per person per week (the message "day" is that week's Monday, so repeated runs never duplicate).
import { pool } from "../db/pool.js";
import { yerevanToday } from "../utils/yerevanDate.js";
import { getVaghinakSettings } from "./settings.js";
import { createMessage, isWorkingDay, minuteOfDay, MANAGEMENT_ROLES } from "./engine.js";
import { durationHy } from "./phrases.js";
import { bullets } from "../utils/bullets.js";

const shiftDay = (day, delta) => new Date(new Date(`${day}T00:00:00Z`).getTime() + delta * 86400000).toISOString().slice(0, 10);
export const mondayOf = (day) => shiftDay(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

const pctOf = (planned, visited) => (planned > 0 ? Math.round((visited / planned) * 100) : null);

// Per rep facts of the week starting at `monday` (null when the rep has no logged day in it).
export async function weekFacts(db, monday, graceMin) {
  const { rows } = await db.query(
    `SELECT l.user_id, u.name, u.name_hy, u.role, u.vaghinak_address,
            count(*) FILTER (WHERE l.first_checkin_at IS NOT NULL)::int AS days,
            COALESCE(sum(l.planned_count), 0)::int AS planned, COALESCE(sum(l.visited_count), 0)::int AS visited,
            count(*) FILTER (WHERE l.first_checkin_at IS NOT NULL AND l.late_minutes > $2)::int AS late_days,
            COALESCE(sum(l.late_minutes) FILTER (WHERE l.first_checkin_at IS NOT NULL AND l.late_minutes > $2), 0)::int AS late_min
     FROM vaghinak_day_log l JOIN users u ON u.id = l.user_id
     WHERE l.day >= $1::date AND l.day < ($1::date + 7) AND NOT l.day_off AND u.role = 'sales_manager'
     GROUP BY l.user_id, u.name, u.name_hy, u.role, u.vaghinak_address ORDER BY u.name`,
    [monday, graceMin]
  );
  return rows.map((r) => ({ ...r, pct: pctOf(r.planned, r.visited) }));
}

export async function weeklyDigest(now = new Date(), db = pool, { pick } = {}) {
  const settings = await getVaghinakSettings(db);
  if (settings.mode === "off") return { created: 0 };
  const day = yerevanToday(now);
  const nowMin = minuteOfDay(now);
  if (nowMin < 9 * 60 || nowMin >= settings.workEndMin) return { created: 0 };
  if (!(await isWorkingDay(db, day))) return { created: 0 };
  const thisMonday = mondayOf(day);
  const lastMonday = shiftDay(thisMonday, -7);
  const week = await weekFacts(db, lastMonday, settings.lateGraceMin);
  if (!week.length) return { created: 0 };

  let created = 0;
  const lines = [];
  const pcts = [];
  let lateDays = 0;
  for (const w of week) {
    const user = { id: w.user_id, name: w.name, name_hy: w.name_hy, role: w.role, vaghinak_address: w.vaghinak_address };
    const first = String(w.name_hy || w.name).trim().split(/\s+/)[0];
    if (w.pct !== null) pcts.push(w.pct);
    lateDays += w.late_days;
    const kind = w.pct === null ? "week_free" : w.pct >= 80 ? "week_high" : w.pct >= 50 ? "week_mid" : "week_low";
    const ctx = {
      pct: w.pct,
      done: w.visited,
      planned: w.planned,
      days: w.days,
      lateNote: w.late_days > 0 ? ` Ուշացումներ եղել է ${w.late_days} օր (ընդհանուր ${durationHy(w.late_min)})՝ այս շաբաթ փորձենք ժամանակին։` : "",
    };
    if (w.days > 0 && (await createMessage(db, user, { kind, level: 1, day: thisMonday, ctx, audience: "rep", settings, pick }))) created++;
    if (w.days === 0 && w.planned > 0) lines.push(`${first} — այցեր չեն եղել`);
    else {
      if (w.late_days >= 2) lines.push(`${first} — ուշացել է ${w.late_days} օր (${durationHy(w.late_min)})`);
      if (w.pct !== null && w.pct < 50) lines.push(`${first} — պլանի ${w.pct}%`);
    }
  }
  const avg = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0;
  const best = week.filter((w) => w.pct !== null).sort((a, b) => b.pct - a.pct)[0];
  const bestName = best ? `${String(best.name_hy || best.name).trim().split(/\s+/)[0]} (${best.pct}%)` : "—";
  const { rows: managers } = await db.query("SELECT id, name, name_hy, role, vaghinak_address FROM users WHERE role = ANY($1)", [MANAGEMENT_ROLES]);
  for (const mgr of managers) {
    const kind = lines.length ? "week_mgmt_issues" : "week_mgmt_quiet";
    const m = await createMessage(db, mgr, { kind, level: 1, day: thisMonday, ctx: { k: lines.length, list: bullets(lines), stats: bullets([`Պլանի միջին կատարումը՝ ${avg}%`, `Լավագույնը՝ ${bestName}`, `Ուշացած օրեր՝ ${lateDays}`, `Մենեջերներ՝ ${week.length}`]) }, audience: "management", settings: { ...settings, mode: "live" }, pick });
    if (m) created++;
  }
  return { created };
}
