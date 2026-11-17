// Reports > Opportunities (owner, 2026-11-17): every customer with a volume potential, ranked by the litres a month they could still buy
// from us (potential - what they buy, per product line; volumeActuals.js). Management sees every customer, a sales manager only their own.
// Filters: places (the "region::subregion" keys of the shared region tree), product lines, reps, services the workshop does. Totals by
// region and by rep.
import { pool } from "../db/pool.js";
import { customerActuals, skuMappings, walletOf, actualsWindow } from "./volumeActuals.js";

const NO_SUB = "__none__"; // the region tree's "no subregion" leaf
const list = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export async function buildOpportunities({ query = {}, scopeUserId = null } = {}, db = pool) {
  const places = new Set(list(query.region_sub));
  const lineIds = list(query.lines).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const reps = list(query.reps).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  const services = list(query.services);
  const params = [];
  const where = ["c.closed_at IS NULL", "(p.customer_id IS NOT NULL OR c.expected_volume_l > 0)"];
  if (scopeUserId) {
    params.push(scopeUserId);
    where.push(`c.assigned_manager_id = $${params.length}`);
  }
  if (reps.length) {
    params.push(reps);
    where.push(`c.assigned_manager_id = ANY($${params.length}::int[])`);
  }
  const { rows: customers } = await db.query(
    `SELECT c.id, c.name, c.region, c.subregion, c.erp_customer_id, c.assigned_manager_id, c.expected_volume_l::float8 AS total_l,
            COALESCE(u.name_hy, u.name) AS rep_name, p.services, p.updated_at AS potential_at,
            COALESCE((SELECT json_agg(json_build_object('line_id', a.line_id, 'amount', a.amount_month::float8)) FROM volume_potential_amounts a WHERE a.customer_id = c.id), '[]') AS lines
       FROM customers c
       LEFT JOIN volume_potential_profiles p ON p.customer_id = c.id
       LEFT JOIN users u ON u.id = c.assigned_manager_id
      WHERE ${where.join(" AND ")}`,
    params
  );
  // places and services: in code (the place key is the tree's own)
  const picked = customers.filter((c) => {
    if (places.size && !places.has(`${c.region}::${c.subregion || NO_SUB}`)) return false;
    if (services.length && !services.every((k) => c.services?.[k]?.does === true)) return false;
    return true;
  });
  const window = actualsWindow();
  const mappings = await skuMappings(db);
  const actuals = picked.length ? await customerActuals(picked.map((c) => c.id), db, { mappings, window }) : new Map();
  const lineFilter = lineIds.length ? new Set(lineIds) : null;
  const rows = [];
  for (const c of picked) {
    const act = actuals.get(c.id) ?? { by_line: {}, total: 0, unmapped: 0 };
    const w = walletOf({ lines: c.lines, total_l: c.total_l }, act, { lineIds: lineFilter });
    if (!(w.potential > 0)) continue;
    rows.push({
      customer_id: c.id,
      name: c.name,
      region: c.region,
      subregion: c.subregion,
      rep_id: c.assigned_manager_id,
      rep_name: c.rep_name,
      has_erp: Boolean(c.erp_customer_id),
      potential_at: c.potential_at,
      potential: w.potential,
      actual: w.actual,
      gap: w.gap,
      share_pct: w.share_pct,
      by_lines: w.by_lines,
      lines: w.lines,
      unmapped: act.unmapped,
    });
  }
  rows.sort((a, b) => b.gap - a.gap || b.potential - a.potential || a.customer_id - b.customer_id);
  const sum = (arr, k) => Math.round(arr.reduce((s, r) => s + r[k], 0) * 10) / 10;
  const groupBy = (keyFn, labelFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (!m.has(k)) m.set(k, { key: k, label: labelFn(r), customers: 0, potential: 0, actual: 0, gap: 0 });
      const g = m.get(k);
      g.customers += 1;
      g.potential += r.potential;
      g.actual += r.actual;
      g.gap += r.gap;
    }
    return [...m.values()]
      .map((g) => ({ ...g, potential: Math.round(g.potential * 10) / 10, actual: Math.round(g.actual * 10) / 10, gap: Math.round(g.gap * 10) / 10, share_pct: g.potential > 0 ? Math.round((g.actual / g.potential) * 100) : null }))
      .sort((a, b) => b.gap - a.gap);
  };
  const totals = { customers: rows.length, potential: sum(rows, "potential"), actual: sum(rows, "actual"), gap: sum(rows, "gap") };
  totals.share_pct = totals.potential > 0 ? Math.round((totals.actual / totals.potential) * 100) : null;
  return {
    window,
    totals,
    by_region: groupBy((r) => r.region || "", (r) => r.region || null),
    by_rep: groupBy((r) => String(r.rep_id ?? ""), (r) => r.rep_name || null),
    rows,
    // the filter lists: places of every customer in scope (not only the filtered ones), reps
    places: customers.map((c) => ({ region: c.region, subregion: c.subregion })),
    reps: [...new Map(customers.filter((c) => c.assigned_manager_id).map((c) => [c.assigned_manager_id, { id: c.assigned_manager_id, name: c.rep_name }])).values()],
    unmapped_skus: mappings.filter((m) => m.status === "unmapped").length,
  };
}
