// Vaghinak's route-plan analysis (owner, 2026-11-03). Looks at every rep's recurring route plan (visit_plan_rules) and SUGGESTS changes; it never
// changes a plan itself: the CEO / admin accepts a suggestion (acceptSuggestion below, one by one or all) and only then the plan is edited.
//   - "move": a customer sits far from the rest of its weekday (farther than 2.5 x the day's usual distance and 3 km) while another, no heavier
//     day is less than half as far: move it there.
//   - "add": a customer of the rep that is on no weekday at all: put it on the weekday whose customers are nearest (within 8 km), the lighter
//     day when two are about as near.
// Only the main plan is analysed (a separately planned channel such as SM B2B keeps its own plan: field/planScopes.js). Pure choice in
// analyzePlan (tested on its own), the database around it below.
import { pool } from "../db/pool.js";
import { distM, hasLocation } from "../orders/routePlanner.js";
import { MAIN_SCOPE, scopeOfChannel } from "./planScopes.js";
import { NO_VISIT_CHANNELS } from "../customers/routes/customers.js";
import { notifyUser } from "../shared/notifications.js";

export const MIN_OUTLIER_M = 3000;
export const OUTLIER_FACTOR = 2.5;
export const ADD_MAX_M = 8000;
export const PER_REP_CAP = 10;
const MIN_LOCATED_IN_DAY = 4;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function centroid(list) {
  const pts = list.filter(hasLocation);
  if (pts.length < MIN_LOCATED_IN_DAY) return null;
  return { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length };
}

/**
 * days: [{ day_of_week, ids: [every customer of the day], movable: [ids that are listed one by one (can be moved)] }]
 * byId: Map(id -> { lat, lng })   unplanned: [{ id, lat, lng }]   ->  [{ kind, customer_id, from_dow, to_dow, reason, gain_m }] best first
 */
export function analyzePlan({ days, byId, unplanned = [] }) {
  const info = days.map((d) => {
    const members = d.ids.map((id) => ({ id, ...byId.get(id) })).filter((m) => hasLocation(m));
    return { ...d, members, center: centroid(members), load: d.ids.length };
  });
  const out = [];
  for (const d of info) {
    if (!d.center) continue;
    const dists = d.members.map((m) => distM(m, d.center));
    const usual = median(dists);
    for (const m of d.members) {
      if (!d.movable.includes(m.id)) continue;
      const own = distM(m, d.center);
      if (own < MIN_OUTLIER_M || own < OUTLIER_FACTOR * usual) continue;
      let best = null;
      for (const o of info) {
        if (o === d || !o.center || o.load > d.load) continue;
        const dist = distM(m, o.center);
        if (dist < own * 0.5 && (!best || dist < best.dist)) best = { o, dist };
      }
      if (best) out.push({ kind: "move", customer_id: m.id, from_dow: d.day_of_week, to_dow: best.o.day_of_week, reason: { own_m: Math.round(own), usual_m: Math.round(usual), target_m: Math.round(best.dist), from_load: d.load, to_load: best.o.load }, gain_m: Math.round(own - best.dist) });
    }
  }
  for (const c of unplanned) {
    if (!hasLocation(c)) continue;
    const near = info.filter((d) => d.center).map((d) => ({ d, dist: distM(c, d.center) })).sort((a, b) => a.dist - b.dist);
    if (!near.length || near[0].dist > ADD_MAX_M) continue;
    const pick = near.filter((n) => n.dist <= near[0].dist * 1.25 + 500).sort((a, b) => a.d.load - b.d.load || a.dist - b.dist)[0];
    out.push({ kind: "add", customer_id: c.id, from_dow: null, to_dow: pick.d.day_of_week, reason: { target_m: Math.round(pick.dist), to_load: pick.d.load }, gain_m: Math.round(ADD_MAX_M - pick.dist) });
  }
  return out.sort((a, b) => b.gain_m - a.gain_m);
}

const coversArea = (areas, c) => (Array.isArray(areas) ? areas : []).some((a) => a?.region && a.region === c.region && (!a.subregion || a.subregion === c.subregion));

/** Runs the analysis for every active rep and replaces the pending suggestions. Returns { created, reps }. */
export async function runRoutePlanAnalysis(db = pool) {
  const { rows: reps } = await db.query("SELECT id, name FROM users WHERE role = 'sales_manager' AND status = 'active'");
  const { rows: dismissed } = await db.query("SELECT rep_id, customer_id, to_dow FROM route_plan_suggestions WHERE status = 'dismissed' AND decided_at > now() - interval '60 days'");
  const skip = new Set(dismissed.map((r) => `${r.rep_id}|${r.customer_id}|${r.to_dow}`));
  await db.query("UPDATE route_plan_suggestions SET status = 'stale' WHERE status = 'pending'");
  let created = 0;
  const perRep = new Map();
  for (const rep of reps) {
    const { rows: rules } = await db.query("SELECT day_of_week, areas, customer_ids FROM visit_plan_rules WHERE user_id = $1 AND active", [rep.id]);
    if (rules.length < 2) continue;
    const { rows: mine } = await db.query(
      `SELECT id, region, subregion, sales_channel, checkin_for_all, customer_tier, lat::float8 AS lat, lng::float8 AS lng FROM customers WHERE assigned_manager_id = $1 OR id = ANY($2)`,
      [rep.id, [...new Set(rules.flatMap((r) => r.customer_ids ?? []))]]
    );
    const visitable = (c) => scopeOfChannel(c.sales_channel) === MAIN_SCOPE && !NO_VISIT_CHANNELS.includes(c.sales_channel) && !c.checkin_for_all && c.customer_tier !== "competitor";
    const eligible = mine.filter(visitable);
    const byId = new Map(eligible.map((c) => [c.id, c]));
    const days = rules.map((r) => {
      const explicit = (r.customer_ids ?? []).filter((id) => byId.has(id));
      const byArea = eligible.filter((c) => coversArea(r.areas, c)).map((c) => c.id);
      return { day_of_week: r.day_of_week, ids: [...new Set([...explicit, ...byArea])], movable: explicit };
    });
    const planned = new Set(days.flatMap((d) => d.ids));
    const unplanned = eligible.filter((c) => !planned.has(c.id));
    const found = analyzePlan({ days, byId, unplanned }).filter((s) => !skip.has(`${rep.id}|${s.customer_id}|${s.to_dow}`)).slice(0, PER_REP_CAP);
    for (const s of found) {
      await db.query("INSERT INTO route_plan_suggestions (rep_id, customer_id, kind, from_dow, to_dow, reason) VALUES ($1, $2, $3, $4, $5, $6)", [rep.id, s.customer_id, s.kind, s.from_dow, s.to_dow, JSON.stringify(s.reason)]);
      created++;
      perRep.set(rep.id, (perRep.get(rep.id) ?? 0) + 1);
    }
  }
  return { created, reps: perRep.size };
}

/** Tells the CEO and the admins that suggestions are waiting (once per run). */
export async function notifyReviewers(count, db = pool) {
  if (!count) return;
  const { rows } = await db.query("SELECT id FROM users WHERE role IN ('ceo', 'admin') AND status = 'active'");
  for (const u of rows) {
    notifyUser(u.id, "route_plan_suggestions", { title: "Վաղինակ՝ երթուղային պլանների առաջարկներ", body: `${count} առաջարկ սպասում է ձեր հաստատմանը`, url: "/#/route-plan-suggestions" }).catch((err) => console.error("Route plan suggestion notification failed:", err.message));
  }
}

const placed = (ids, id) => (ids.includes(id) ? ids : [...ids, id]);

/**
 * Applies ONE pending suggestion in a transaction (the plan changes only here). Re-checks that it still makes sense; a changed plan marks it stale.
 * Returns { ok: true } | { ok: false, reason }.
 */
export async function acceptSuggestion(id, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [s] } = await client.query("SELECT * FROM route_plan_suggestions WHERE id = $1 FOR UPDATE", [id]);
    if (!s) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (s.status !== "pending") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_pending" };
    }
    const { rows: rules } = await client.query("SELECT id, day_of_week, customer_ids FROM visit_plan_rules WHERE user_id = $1 AND active FOR UPDATE", [s.rep_id]);
    const to = rules.find((r) => r.day_of_week === s.to_dow);
    const from = s.kind === "move" ? rules.find((r) => r.day_of_week === s.from_dow) : null;
    const stillValid = to && !rules.some((r) => (r.customer_ids ?? []).includes(s.customer_id) && r.day_of_week === s.to_dow) && (s.kind === "add" ? !rules.some((r) => (r.customer_ids ?? []).includes(s.customer_id)) : from && (from.customer_ids ?? []).includes(s.customer_id));
    if (!stillValid) {
      await client.query("UPDATE route_plan_suggestions SET status = 'stale' WHERE id = $1", [id]);
      await client.query("COMMIT");
      return { ok: false, reason: "plan_changed" };
    }
    if (from) await client.query("UPDATE visit_plan_rules SET customer_ids = $2, updated_at = now() WHERE id = $1", [from.id, from.customer_ids.filter((x) => x !== s.customer_id)]);
    await client.query("UPDATE visit_plan_rules SET customer_ids = $2, updated_at = now() WHERE id = $1", [to.id, placed(to.customer_ids ?? [], s.customer_id)]);
    // the active plan set holds the same plan: the same change there, so the Route plans screen shows it too
    const { rows: setRules } = await client.query(
      `SELECT r.set_id, r.day_of_week, r.customer_ids FROM route_plan_set_rules r JOIN route_plan_sets st ON st.id = r.set_id WHERE st.is_active AND r.user_id = $1 FOR UPDATE OF r`,
      [s.rep_id]
    );
    for (const r of setRules) {
      let ids = r.customer_ids ?? [];
      if (from && r.day_of_week === s.from_dow) ids = ids.filter((x) => x !== s.customer_id);
      if (r.day_of_week === s.to_dow) ids = placed(ids, s.customer_id);
      if (JSON.stringify(ids) !== JSON.stringify(r.customer_ids ?? [])) await client.query("UPDATE route_plan_set_rules SET customer_ids = $3 WHERE set_id = $1 AND user_id = $2 AND day_of_week = $4", [r.set_id, s.rep_id, ids, r.day_of_week]);
    }
    await client.query("UPDATE route_plan_suggestions SET status = 'accepted', decided_by = $2, decided_at = now() WHERE id = $1", [id, userId]);
    await client.query("COMMIT");
    return { ok: true, suggestion: s };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
