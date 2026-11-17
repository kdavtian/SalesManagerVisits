// Customer volume potential (owner, 2026-11-17): the workshop profile, the services it does and its monthly potential per product line, on
// the combined «Պոտենցիալ» card. The TOTAL is customers.expected_volume_l, the existing "whole monthly need" (owner: one number), so the
// funnel (team/vaghinak/funnel.js) and the card always show the same value. Every save keeps a before/after row (volume_potential_history).
// Phase 2 compares the lines with what the customer buys from us.
import { pool } from "../db/pool.js";

// The services a workshop can do; `buys` = ask "do they buy it from us?", `machine` = ask "has the machine?". Keys are stored, labels are
// the screen's (i18n vp_svc_<key>).
export const SERVICES = [
  { key: "engine_oil", buys: true },
  { key: "gear_manual", buys: true },
  { key: "atf_drain", buys: true },
  { key: "atf_flush", buys: true, machine: true },
  { key: "dsg_dct", buys: true },
  { key: "cvt", buys: true },
  { key: "ev_transmission", buys: true },
  { key: "ev_thermal", buys: true },
  { key: "hybrid", buys: false },
  { key: "coolant", buys: true },
  { key: "brake", buys: true },
  { key: "power_steering", buys: true },
  { key: "grease", buys: true },
  { key: "diesel_truck", buys: false },
  { key: "ac", buys: false },
  { key: "tyres", buys: false },
  { key: "diagnostics", buys: false },
];
export const VEHICLES = ["passenger", "light_commercial", "trucks", "agri_construction", "motorcycles", "hybrids", "evs", "european", "asian", "us_market"];
export const BRANDS = ["castrol", "mobil", "shell", "total", "liquimoly", "lukoil", "rosneft", "motul", "zic", "other"];
const SOURCES = ["rep_estimate", "customer_stated", "invoice"];
const CONFIDENCE = ["low", "med", "high"];

export class VolumePotentialError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const fail = (m) => {
  throw new VolumePotentialError(m);
};
const intOrNull = (v, max, what) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) fail(`Bad ${what}`);
  return n;
};
const pick = (list, values, what) => {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) fail(`Bad ${what}`);
  const out = [...new Set(values.map(String))];
  if (out.some((v) => !list.includes(v))) fail(`Unknown ${what}`);
  return out;
};

// The body of a save -> clean values (throws VolumePotentialError on a bad one). total_l: undefined = leave the monthly need as it is.
export function cleanVolumePotential(b = {}, lineIds = new Set()) {
  const services = {};
  if (b.services !== undefined && b.services !== null) {
    if (typeof b.services !== "object" || Array.isArray(b.services)) fail("Bad services");
    for (const [key, v] of Object.entries(b.services)) {
      const def = SERVICES.find((s) => s.key === key);
      if (!def) fail("Unknown service");
      if (!v || typeof v !== "object") fail("Bad services");
      const does = v.does === true;
      services[key] = {
        does,
        buys: does && def.buys && typeof v.buys === "boolean" ? v.buys : null,
        machine: does && def.machine && typeof v.machine === "boolean" ? v.machine : null,
      };
    }
  }
  const lines = [];
  if (b.lines !== undefined && b.lines !== null) {
    if (!Array.isArray(b.lines)) fail("Bad lines");
    for (const l of b.lines) {
      const lineId = Number(l?.line_id);
      if (!lineIds.has(lineId)) fail("Unknown product line");
      if (l.amount === null || l.amount === undefined || l.amount === "") continue;
      const amount = Number(l.amount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e6) fail("Bad amount");
      if (amount === 0) continue;
      const share = l.our_share_pct === null || l.our_share_pct === undefined || l.our_share_pct === "" ? null : Number(l.our_share_pct);
      if (share !== null && (!Number.isInteger(share) || share < 0 || share > 100)) fail("Bad share");
      if (lines.some((x) => x.line_id === lineId)) fail("A product line twice");
      lines.push({ line_id: lineId, amount: Math.round(amount * 10) / 10, our_share_pct: share });
    }
  }
  let total;
  if (b.total_l !== undefined) {
    if (b.total_l === null || b.total_l === "") total = null;
    else {
      total = Number(b.total_l);
      if (!Number.isFinite(total) || total < 0 || total > 1e6) fail("Bad total");
      total = Math.round(total * 10) / 10;
    }
  }
  const brandsOther = typeof b.brands_other === "string" ? b.brands_other.trim().slice(0, 120) || null : null;
  if (b.source != null && !SOURCES.includes(b.source)) fail("Bad source");
  if (b.confidence != null && !CONFIDENCE.includes(b.confidence)) fail("Bad confidence");
  return {
    cars_per_month: intOrNull(b.cars_per_month, 100000, "cars per month"),
    bays: intOrNull(b.bays, 1000, "bays"),
    vehicle_mix: pick(VEHICLES, b.vehicle_mix, "vehicle"),
    brands: pick(BRANDS, b.brands, "brand"),
    brands_other: brandsOther,
    services,
    source: b.source ?? null,
    confidence: b.confidence ?? null,
    lines,
    total,
    client_ref: typeof b.client_ref === "string" && b.client_ref.length <= 80 ? b.client_ref : null,
  };
}

export async function activeLines(db = pool, { all = false } = {}) {
  const { rows } = await db.query(
    `SELECT id, code, group_key, name_en, name_hy, unit, castrol_hint, sort_order, active FROM volume_potential_lines ${all ? "" : "WHERE active"} ORDER BY sort_order, id`
  );
  return rows;
}

// The brands seen at the customer's last shelf check (a starting point when nothing is saved yet): Castrol when it was on the shelf in any
// form, and the competitors the profile knows by the same key.
async function brandsFromVisits(customerId, db) {
  const { rows: [r] } = await db.query(
    `SELECT brand_status FROM checkins WHERE customer_id = $1 AND brand_status IS NOT NULL AND brand_status <> '{}'::jsonb
     ORDER BY timestamp DESC LIMIT 1`,
    [customerId]
  );
  const bs = r?.brand_status ?? {};
  const out = [];
  if (Array.isArray(bs.castrol) && bs.castrol.some((v) => v !== "unavailable")) out.push("castrol");
  for (const c of Array.isArray(bs.competitors) ? bs.competitors : []) if (BRANDS.includes(c) && !out.includes(c)) out.push(c);
  return out;
}

// Everything the card and the sheet show. `profile` is null when never filled.
export async function loadVolumePotential(customerId, db = pool) {
  // one at a time: inside a save `db` is the transaction's single client, which must not run two queries at once
  const queries = [
    () => db.query(
      `SELECT p.cars_per_month, p.bays, p.vehicle_mix, p.brands, p.brands_other, p.services, p.source, p.confidence, p.updated_at,
              COALESCE(u.name_hy, u.name) AS updated_by_name
       FROM volume_potential_profiles p LEFT JOIN users u ON u.id = p.updated_by WHERE p.customer_id = $1`,
      [customerId]
    ),
    () => db.query("SELECT line_id, amount_month::float8 AS amount, our_share_pct FROM volume_potential_amounts WHERE customer_id = $1", [customerId]),
    () => db.query("SELECT expected_volume_l::float8 AS total_l, expected_volume_at FROM customers WHERE id = $1", [customerId]),
  ];
  const results = db === pool ? await Promise.all(queries.map((q) => q())) : [await queries[0](), await queries[1](), await queries[2]()];
  const [{ rows: [profile] }, { rows: lines }, { rows: [c] }] = results;
  return {
    profile: profile ?? null,
    lines,
    total_l: c?.total_l ?? null,
    total_at: c?.expected_volume_at ?? null,
    brands_from_visits: profile ? null : await brandsFromVisits(customerId, db),
  };
}

const snapshot = (v) => ({
  profile: v.profile
    ? { cars_per_month: v.profile.cars_per_month, bays: v.profile.bays, vehicle_mix: v.profile.vehicle_mix, brands: v.profile.brands, brands_other: v.profile.brands_other, services: v.profile.services, source: v.profile.source, confidence: v.profile.confidence }
    : null,
  lines: [...v.lines].sort((a, b) => a.line_id - b.line_id),
  total_l: v.total_l,
});

// One save: the profile, the lines (replaced as a whole) and, when sent, the total monthly need; plus the history row. A save sent again
// from the offline queue (same client_ref) changes nothing.
export async function saveVolumePotential(customerId, userId, body, db = pool) {
  const lines = await activeLines(db, { all: true });
  const v = cleanVolumePotential(body, new Set(lines.map((l) => l.id)));
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM customers WHERE id = $1 FOR UPDATE", [customerId]);
    if (v.client_ref) {
      const { rowCount } = await client.query("SELECT 1 FROM volume_potential_history WHERE client_ref = $1", [v.client_ref]);
      if (rowCount) {
        await client.query("ROLLBACK");
        return { ...(await loadVolumePotential(customerId, db)), duplicate: true };
      }
    }
    const before = await loadVolumePotential(customerId, client);
    await client.query(
      `INSERT INTO volume_potential_profiles (customer_id, cars_per_month, bays, vehicle_mix, brands, brands_other, services, source, confidence, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, now())
       ON CONFLICT (customer_id) DO UPDATE SET cars_per_month = EXCLUDED.cars_per_month, bays = EXCLUDED.bays, vehicle_mix = EXCLUDED.vehicle_mix,
         brands = EXCLUDED.brands, brands_other = EXCLUDED.brands_other, services = EXCLUDED.services, source = EXCLUDED.source,
         confidence = EXCLUDED.confidence, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [customerId, v.cars_per_month, v.bays, v.vehicle_mix, v.brands, v.brands_other, JSON.stringify(v.services), v.source, v.confidence, userId]
    );
    await client.query("DELETE FROM volume_potential_amounts WHERE customer_id = $1", [customerId]);
    for (const l of v.lines) {
      await client.query("INSERT INTO volume_potential_amounts (customer_id, line_id, amount_month, our_share_pct) VALUES ($1, $2, $3, $4)", [customerId, l.line_id, l.amount, l.our_share_pct]);
    }
    // the total is the customer's whole monthly need (the funnel's stage 4 reads it): written, and its date renewed, when sent
    if (v.total !== undefined) {
      await client.query("UPDATE customers SET expected_volume_l = $2, expected_volume_at = now(), expected_volume_by = $3 WHERE id = $1", [customerId, v.total, userId]);
    }
    const after = await loadVolumePotential(customerId, client);
    await client.query("INSERT INTO volume_potential_history (customer_id, changed_by, before, after, client_ref) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)", [
      customerId,
      userId,
      before.profile || before.lines.length || before.total_l != null ? JSON.stringify(snapshot(before)) : null,
      JSON.stringify(snapshot(after)),
      v.client_ref,
    ]);
    await client.query("COMMIT");
    return after;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function volumePotentialHistory(customerId, db = pool) {
  const { rows } = await db.query(
    `SELECT h.id, h.changed_at, COALESCE(u.name_hy, u.name) AS changed_by_name, h.before, h.after
     FROM volume_potential_history h LEFT JOIN users u ON u.id = h.changed_by
     WHERE h.customer_id = $1 ORDER BY h.changed_at DESC, h.id DESC LIMIT 50`,
    [customerId]
  );
  return rows;
}

// The catalogue (admin): change a line, or add one. A code never changes (it is the line's key).
export async function saveLine(id, b, db = pool) {
  const name_en = String(b?.name_en ?? "").trim().slice(0, 80);
  const name_hy = String(b?.name_hy ?? "").trim().slice(0, 80);
  if (!name_en || !name_hy) throw new VolumePotentialError("Both names are required");
  const unit = b?.unit === "kg" ? "kg" : "L";
  const hint = String(b?.castrol_hint ?? "").trim().slice(0, 80) || null;
  const sort = Number.isInteger(Number(b?.sort_order)) ? Number(b.sort_order) : 0;
  const active = b?.active !== false;
  if (id) {
    const { rows: [r] } = await db.query(
      `UPDATE volume_potential_lines SET name_en = $2, name_hy = $3, unit = $4, castrol_hint = $5, sort_order = $6, active = $7, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, name_en, name_hy, unit, hint, sort, active]
    );
    if (!r) throw new VolumePotentialError("Line not found", 404);
    return r;
  }
  const group = ["pcmo", "hdeo", "transmission", "ev", "coolant", "brake", "grease", "other"].includes(b?.group_key) ? b.group_key : "other";
  const code = `custom_${Date.now().toString(36)}`;
  const { rows: [r] } = await db.query(
    `INSERT INTO volume_potential_lines (code, group_key, name_en, name_hy, unit, castrol_hint, sort_order, active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [code, group, name_en, name_hy, unit, hint, sort, active]
  );
  return r;
}
