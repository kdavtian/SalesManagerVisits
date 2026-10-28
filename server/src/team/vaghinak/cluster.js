// CLUSTER-SKIP rule (V2): the rep visited a customer, customers of TODAY'S PLAN stand within a few hundred metres of
// that place and are still unvisited, and the rep has now moved far away -> one friendly reminder naming them, while
// he can still turn back (owner, 2026-10-15: "within 300 m, before he goes far", at most 2 reminders a day).
// findLeftBehind is pure (coordinates in, customers out); clusterChase loads the data and writes the message.
import { haversineMeters } from "../../utils/geo.js";
import { createMessage } from "./engine.js";
import { bulletNames } from "../../utils/bullets.js";

const MAX_PER_DAY = 2;

const dist = (a, b) => haversineMeters(a.lat, a.lng, b.lat, b.lng);

// fieldVisits: today's field check-ins, oldest first, as { customerId, lat, lng } (the customers' pins).
// candidates: planned, still unvisited customers { id, name, lat, lng }.
export function findLeftBehind({ fieldVisits, candidates, radiusM, farM }) {
  if (fieldVisits.length < 2 || !candidates.length) return [];
  const last = fieldVisits[fieldVisits.length - 1];
  const found = new Map();
  for (const visit of fieldVisits.slice(0, -1)) {
    if (visit.customerId === last.customerId || dist(visit, last) <= farM) continue; // still around there
    for (const c of candidates) {
      if (found.has(c.id) || dist(visit, c) > radiusM || dist(last, c) <= farM) continue;
      found.set(c.id, { ...c, fromM: Math.round(dist(visit, c)) });
    }
  }
  return [...found.values()].sort((a, b) => a.fromM - b.fromM);
}


// states: loadRepStates() result (reps with their checkins, plan and visited sets)
export async function clusterChase({ db, day, settings, pick, states }) {
  const wanted = states.filter((s) => s.facts.fieldVisits >= 2 && s.facts.remaining > 0);
  if (!wanted.length) return 0;
  const ids = new Set();
  for (const s of wanted) {
    for (const id of s.plan) ids.add(id);
    for (const c of s.checkins) ids.add(c.customerId);
  }
  const { rows } = await db.query("SELECT id, name, lat::float8 AS lat, lng::float8 AS lng FROM customers WHERE id = ANY($1) AND lat IS NOT NULL AND lng IS NOT NULL", [[...ids]]);
  const pins = new Map(rows.map((r) => [r.id, r]));
  let created = 0;
  for (const { rep, checkins, plan, visited } of wanted) {
    const fieldVisits = checkins.filter((c) => !c.isOffice && pins.has(c.customerId)).map((c) => ({ customerId: c.customerId, lat: pins.get(c.customerId).lat, lng: pins.get(c.customerId).lng }));
    const candidates = [...plan].filter((id) => !visited.has(id) && pins.has(id)).map((id) => pins.get(id));
    const left = findLeftBehind({ fieldVisits, candidates, radiusM: settings.clusterRadiusM, farM: settings.clusterFarM });
    if (!left.length) continue;
    const { rows: sent } = await db.query("SELECT level, facts FROM vaghinak_messages WHERE user_id = $1 AND kind = 'cluster_skip' AND day = $2", [rep.id, day]);
    if (sent.length >= MAX_PER_DAY) continue;
    const told = new Set(sent.flatMap((m) => m.facts?.ids ?? []));
    const fresh = left.filter((c) => !told.has(c.id));
    if (!fresh.length) continue;
    const level = sent.length + 1;
    const message = await createMessage(db, rep, { kind: "cluster_skip", level, day, ctx: { n: fresh.length, names: bulletNames(fresh.map((c) => c.name)), ids: fresh.map((c) => c.id) }, audience: "rep", settings, pick });
    if (message) created++;
  }
  return created;
}
