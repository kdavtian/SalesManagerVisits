// Vaghinak's engine: every few minutes during the working day it looks at each sales rep, runs the rules
// (evaluate.js), writes the silent day log, and turns what it finds into messages (phrases.js) -- reminders first,
// then a mandatory question if the rep keeps ignoring the situation. At the end of the day: a wrap-up for every rep
// and a short brief for management. mode = "shadow" records everything for management only (nothing reaches reps).
import { pool } from "../db/pool.js";
import { notifyUser } from "../notifications.js";
import { yerevanToday } from "../utils/yerevanDate.js";
import { batchExpandAreas } from "../routes/visitPlans.js";
import { evaluateRep, flagsOf } from "./evaluate.js";
import { getVaghinakSettings } from "./settings.js";
import { addressFor, clock, durationHy, pickVariant, QUESTION_CHOICES } from "./phrases.js";

const YEREVAN_OFFSET_MS = 4 * 60 * 60 * 1000;
export const MANAGEMENT_ROLES = ["admin", "ceo", "operations_director", "sales_director", "accountant"];
const MANDATORY_ROLES = new Set(["sales_manager"]); // only field reps are ever blocked by a question

export const minuteOfDay = (date) => {
  const d = new Date(date.getTime() + YEREVAN_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

async function isWorkingDay(db, day) {
  if (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) return false;
  const { rows } = await db.query("SELECT 1 FROM company_holidays WHERE holiday_date = $1", [day]);
  return rows.length === 0;
}

// Today's planned customers per rep: an explicit approved visit_plans row wins, else the recurring rule of the weekday.
export async function plannedForDay(db, userIds, day) {
  const out = new Map(userIds.map((id) => [id, new Set()]));
  if (!userIds.length) return out;
  const { rows: persisted } = await db.query("SELECT user_id, customer_ids, status FROM visit_plans WHERE user_id = ANY($1) AND plan_date = $2", [userIds, day]);
  const persistedIds = new Set(persisted.map((r) => r.user_id));
  for (const r of persisted) if (r.status === "approved") for (const id of r.customer_ids ?? []) out.get(r.user_id).add(id);
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  const { rows: rules } = await db.query("SELECT * FROM visit_plan_rules WHERE user_id = ANY($1) AND day_of_week = $2 AND active", [userIds, dow]);
  const areaIds = await batchExpandAreas(rules);
  for (const rule of rules) {
    if (persistedIds.has(rule.user_id)) continue;
    for (const id of [...(areaIds.get(rule.id) ?? []), ...(rule.customer_ids ?? [])]) out.get(rule.user_id).add(id);
  }
  return out;
}

async function todaysCheckins(db, userIds, day) {
  if (!userIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT ch.user_id, ch.customer_id, ch.timestamp, COALESCE(c.checkin_for_all, false) AS is_office
     FROM checkins ch JOIN customers c ON c.id = ch.customer_id
     WHERE ch.user_id = ANY($1)
       AND ch.timestamp >= ($2::date::timestamp AT TIME ZONE 'Asia/Yerevan')
       AND ch.timestamp < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Yerevan')
     ORDER BY ch.timestamp`,
    [userIds, day]
  );
  const out = new Map(userIds.map((id) => [id, []]));
  for (const r of rows) out.get(r.user_id).push({ at: r.timestamp, atMin: minuteOfDay(r.timestamp), isOffice: r.is_office, customerId: r.customer_id });
  return out;
}

export async function loadRepStates(db, day, nowMin, settings, { includeMuted = false } = {}) {
  const { rows: reps } = await db.query(
    `SELECT id, name, name_hy, role, vaghinak_address, (vaghinak_muted_day = $1::date) AS muted
     FROM users WHERE role = 'sales_manager' ORDER BY name`,
    [day]
  );
  const active = includeMuted ? reps : reps.filter((r) => !r.muted);
  const ids = active.map((r) => r.id);
  const [planned, checkins] = await Promise.all([plannedForDay(db, ids, day), todaysCheckins(db, ids, day)]);
  return active.map((rep) => {
    const cks = checkins.get(rep.id) ?? [];
    const plan = planned.get(rep.id) ?? new Set();
    const visited = new Set(cks.filter((c) => !c.isOffice).map((c) => c.customerId));
    const visitedPlanned = [...plan].filter((id) => visited.has(id)).length;
    const result = evaluateRep({ nowMin, settings, checkins: cks, plannedCount: plan.size, visitedPlanned });
    return { rep, checkins: cks, ...result };
  });
}

async function recentVariants(db, userId) {
  const { rows } = await db.query("SELECT variant FROM vaghinak_messages WHERE user_id = $1 AND variant IS NOT NULL ORDER BY created_at DESC LIMIT 10", [userId]);
  return rows.map((r) => r.variant);
}

// Writes one message (once per person / kind / day / level). Returns the new row, or null if it already existed,
// the daily cap was reached, or there is nothing to say.
export async function createMessage(db, user, { kind, level, day, ctx = {}, audience, severity = "info", settings, pick }) {
  const variants = await recentVariants(db, user.id);
  const withAddr = { ...ctx, addr: addressFor(user, audience, pick) };
  const { text, variant } = pickVariant(kind, level, audience, withAddr, variants, pick);
  const choices = QUESTION_CHOICES[kind] ?? null;
  const needsAnswer = Boolean(choices) && (level === 2 || kind === "not_started");
  const mandatory = needsAnswer && level === 2 && MANDATORY_ROLES.has(user.role);
  const shadow = settings.mode !== "live";
  if (!mandatory && !shadow) {
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM vaghinak_messages WHERE user_id = $1 AND day = $2 AND NOT shadow AND NOT mandatory",
      [user.id, day]
    );
    if (rows[0].n >= settings.dailyCap) return null;
  }
  const { rows } = await db.query(
    `INSERT INTO vaghinak_messages (user_id, kind, day, level, severity, body, facts, variant, needs_answer, mandatory, choices, shadow)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb, $12)
     ON CONFLICT (user_id, kind, day, level) DO NOTHING RETURNING *`,
    [user.id, kind, day, level, mandatory ? "important" : severity, text, JSON.stringify(ctx), variant, needsAnswer, mandatory, choices ? JSON.stringify(choices) : null, shadow]
  );
  const message = rows[0] ?? null;
  if (message && !shadow) {
    await notifyUser(user.id, "vaghinak", { title: "Վաղինակ", body: text.slice(0, 160), url: "/#/vaghinak" });
  }
  return message;
}

const FLAG_CONTEXT = (f) => ({
  late: f.lateMinutes,
  time: clock(f.nowMin ?? 0),
  dur: durationHy(f.officeMinutes),
  idle: durationHy(f.idleMinutes),
  n: f.remaining,
});

// One pass over the reps. Safe to run any number of times: messages are unique per person / kind / day / level.
export async function tick(now = new Date(), db = pool, { pick } = {}) {
  const settings = await getVaghinakSettings(db);
  if (settings.mode === "off") return { created: 0 };
  const day = yerevanToday(now);
  if (!(await isWorkingDay(db, day))) return { created: 0 };
  const nowMin = minuteOfDay(now);
  if (nowMin < settings.workStartMin - 30) return { created: 0 };

  const states = await loadRepStates(db, day, nowMin, settings);
  let created = 0;
  for (const { rep, facts, actions } of states) {
    await db.query(
      `INSERT INTO vaghinak_day_log (user_id, day, first_checkin_at, late_minutes, office_minutes, planned_count, visited_count, last_checkin_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (user_id, day) DO UPDATE SET
         first_checkin_at = COALESCE(vaghinak_day_log.first_checkin_at, EXCLUDED.first_checkin_at),
         late_minutes = CASE WHEN vaghinak_day_log.first_checkin_at IS NOT NULL THEN vaghinak_day_log.late_minutes ELSE EXCLUDED.late_minutes END,
         office_minutes = GREATEST(vaghinak_day_log.office_minutes, EXCLUDED.office_minutes),
         planned_count = EXCLUDED.planned_count, visited_count = EXCLUDED.visited_count,
         last_checkin_at = EXCLUDED.last_checkin_at, updated_at = now()`,
      [rep.id, day, facts.started ? firstAt(states, rep.id) : null, facts.started ? facts.lateMinutes : 0, facts.officeMinutes, facts.plannedCount, facts.visitedPlanned, lastAt(states, rep.id)]
    );
    for (const action of actions) {
      const message = await createMessage(db, rep, { ...action, day, ctx: FLAG_CONTEXT({ ...facts, nowMin }), audience: "rep", settings, pick });
      if (message) created++;
    }
  }
  return { created };
}

const firstAt = (states, id) => states.find((s) => s.rep.id === id)?.checkins[0]?.at ?? null;
const lastAt = (states, id) => {
  const c = states.find((s) => s.rep.id === id)?.checkins;
  return c?.length ? c[c.length - 1].at : null;
};

// End of day: a wrap-up for each rep and the management brief. Once per day (unique messages), after workEnd + 5 min.
export async function wrapUp(now = new Date(), db = pool, { pick } = {}) {
  const settings = await getVaghinakSettings(db);
  if (settings.mode === "off") return { created: 0 };
  const day = yerevanToday(now);
  const nowMin = minuteOfDay(now);
  if (nowMin < settings.workEndMin + 5 || nowMin > 23 * 60) return { created: 0 };
  if (!(await isWorkingDay(db, day))) return { created: 0 };

  const { rows: logs } = await db.query(
    `SELECT l.*, u.name, u.name_hy, u.role, u.vaghinak_address
     FROM vaghinak_day_log l JOIN users u ON u.id = l.user_id
     WHERE l.day = $1 AND u.role = 'sales_manager' AND NOT l.day_off ORDER BY u.name`,
    [day]
  );
  let created = 0;
  const lines = [];
  const pcts = [];
  let lateN = 0;
  for (const l of logs) {
    const user = { id: l.user_id, name: l.name, name_hy: l.name_hy, role: l.role, vaghinak_address: l.vaghinak_address };
    const first = String(l.name_hy || l.name).trim().split(/\s+/)[0];
    const pct = l.planned_count > 0 ? Math.round((l.visited_count / l.planned_count) * 100) : null;
    if (pct !== null) pcts.push(pct);
    if (l.late_minutes > settings.lateGraceMin) lateN++;
    if (l.planned_count > 0 || l.visited_count > 0) {
      const kind = pct === null ? "day_wrap_free" : pct >= 80 ? "day_wrap_high" : pct >= 50 ? "day_wrap_mid" : "day_wrap_low";
      const m = await createMessage(db, user, { kind, level: 1, day, ctx: { done: l.visited_count, planned: l.planned_count, pct }, audience: "rep", settings, pick });
      if (m) created++;
    }
    if (!l.first_checkin_at && l.planned_count > 0) lines.push(`${first} — այցեր չկան`);
    else {
      if (l.late_minutes > settings.lateGraceMin) lines.push(`${first} — ուշացել է ${l.late_minutes} րոպե`);
      if (pct !== null && pct < 50) lines.push(`${first} — պլանի ${pct}%`);
    }
  }
  const { rows: unanswered } = await db.query(
    `SELECT count(*)::int AS n FROM vaghinak_messages WHERE day = $1 AND mandatory AND answered_at IS NULL AND NOT shadow`,
    [day]
  );
  if (unanswered[0].n) lines.push(`${unanswered[0].n} պարտադիր հարցի պատասխան չկա`);
  const avg = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : 0;
  const { rows: managers } = await db.query("SELECT id, name, name_hy, role, vaghinak_address FROM users WHERE role = ANY($1)", [MANAGEMENT_ROLES]);
  for (const mgr of managers) {
    const kind = lines.length ? "mgmt_brief_issues" : "mgmt_brief_quiet";
    const m = await createMessage(db, mgr, { kind, level: 1, day, ctx: { avg, lateN, k: lines.length, list: lines.join("; ") }, audience: "management", settings: { ...settings, mode: "live" }, pick });
    if (m) created++;
  }
  return { created };
}

// For the Team pulse screen: the same facts, right now.
export async function teamPulse(now = new Date(), db = pool) {
  const settings = await getVaghinakSettings(db);
  const day = yerevanToday(now);
  const nowMin = minuteOfDay(now);
  const states = await loadRepStates(db, day, nowMin, settings, { includeMuted: true });
  const { rows: open } = await db.query(
    "SELECT user_id, count(*)::int AS n FROM vaghinak_messages WHERE day = $1 AND needs_answer AND answered_at IS NULL GROUP BY user_id",
    [day]
  );
  const openBy = new Map(open.map((r) => [r.user_id, r.n]));
  return {
    day,
    nowMin,
    settings,
    reps: states.map(({ rep, facts }) => ({
      user_id: rep.id,
      name: rep.name_hy || rep.name,
      muted: Boolean(rep.muted),
      ...facts,
      flags: flagsOf(facts, settings, nowMin),
      open_questions: openBy.get(rep.id) ?? 0,
    })),
  };
}

let timer = null;
export function startVaghinak() {
  if (timer) return;
  timer = setInterval(() => {
    const now = new Date();
    tick(now).catch((err) => console.error("Vaghinak tick failed:", err.message));
    wrapUp(now).catch((err) => console.error("Vaghinak wrap-up failed:", err.message));
  }, 5 * 60 * 1000);
  timer.unref?.();
}
