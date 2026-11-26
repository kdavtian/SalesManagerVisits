// Reading the market data reps record at check-ins, cleaned by priceRules.js: competitor price entries with their per-litre prices and
// flags, and each rep's data-quality numbers. SQL lives here, not in the route file (docs/architecture-roadmap.md).
import { pool } from "../../db/pool.js";
import { shelfRecordedSql } from "../../field/shelfData.js";
import { flagEntries, qualityScore, aggregateMeta } from "./priceRules.js";

// The medians that decide what is an outlier look this far back (a price war of one month must not flag the next month's prices).
export const FLAG_WINDOW_DAYS = 365;

// Every competitor price entry recorded since `since` (default FLAG_WINDOW_DAYS), flagged against the same window.
// -> [{ id, checkin_id, customer_id, customer_name, region, sales_channel, user_id, rep_name, brand_key, brand_name, line_code,
//       line_name_en, line_name_hy, volume, unit, wholesale_amd, retail_amd, recorded_at, wholesale_per_unit, retail_per_unit, flags }]
export async function loadPriceEntries({ since = null, db = pool } = {}) {
  const from = since ?? new Date(Date.now() - FLAG_WINDOW_DAYS * 86400000);
  const { rows } = await db.query(
    `SELECT p.id, p.checkin_id, p.customer_id, c.name AS customer_name, c.region, c.sales_channel,
            p.user_id, COALESCE(u.name_hy, u.name) AS rep_name,
            p.brand_key, COALESCE(b.name, p.brand_key) AS brand_name,
            p.line_code, l.name_en AS line_name_en, l.name_hy AS line_name_hy,
            p.volume::float8 AS volume, p.unit, p.wholesale_amd, p.retail_amd, p.recorded_at
     FROM competitor_prices p
     JOIN customers c ON c.id = p.customer_id
     LEFT JOIN users u ON u.id = p.user_id
     LEFT JOIN competitor_brands b ON b.key = p.brand_key
     LEFT JOIN volume_potential_lines l ON l.code = p.line_code
     WHERE p.recorded_at >= $1
     ORDER BY p.recorded_at DESC, p.id DESC`,
    [from]
  );
  return flagEntries(rows);
}

// Each rep's market data over the last `days` days (management, report market_quality): visits, visits with shelf data, visits with a
// price, price entries, flagged entries, score. Visits of the office "check-in for all" places are not shop visits and are left out.
// -> { reps: [...], totals: {...}, flagged: [latest flagged entries of the period], meta: { latest_at, shops, entries } }
export async function marketQuality({ days = 30, db = pool, flaggedLimit = 200 } = {}) {
  const since = new Date(Date.now() - days * 86400000);
  const [{ rows: visits }, entries] = await Promise.all([
    db.query(
      `SELECT ch.user_id, COALESCE(u.name_hy, u.name) AS rep_name,
              count(*)::int AS visits,
              count(*) FILTER (WHERE ${shelfRecordedSql("ch")})::int AS shelf_visits,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM competitor_prices p WHERE p.checkin_id = ch.id))::int AS price_visits,
              max(ch.timestamp) AS last_visit_at
       FROM checkins ch
       JOIN users u ON u.id = ch.user_id
       JOIN customers c ON c.id = ch.customer_id AND NOT c.checkin_for_all
       WHERE ch.timestamp >= $1
       GROUP BY ch.user_id, u.name_hy, u.name`,
      [since]
    ),
    loadPriceEntries({ db }),
  ]);
  const inPeriod = entries.filter((e) => new Date(e.recorded_at) >= since);
  const byRep = new Map();
  for (const e of inPeriod) {
    const r = byRep.get(e.user_id) ?? { price_entries: 0, flagged_entries: 0 };
    r.price_entries += 1;
    if (e.flags.length) r.flagged_entries += 1;
    byRep.set(e.user_id, r);
  }
  const reps = visits.map((v) => {
    const p = byRep.get(v.user_id) ?? { price_entries: 0, flagged_entries: 0 };
    const row = { ...v, ...p };
    row.score = qualityScore({ visits: v.visits, shelfVisits: v.shelf_visits, priceVisits: v.price_visits, priceEntries: p.price_entries, flaggedEntries: p.flagged_entries });
    return row;
  });
  // the weakest data first: management talks to those reps
  reps.sort((a, b) => (a.score ?? 101) - (b.score ?? 101) || b.visits - a.visits || String(a.rep_name).localeCompare(String(b.rep_name)));
  const sum = (k) => reps.reduce((n, r) => n + r[k], 0);
  const totals = {
    visits: sum("visits"),
    shelf_visits: sum("shelf_visits"),
    price_visits: sum("price_visits"),
    price_entries: sum("price_entries"),
    flagged_entries: sum("flagged_entries"),
  };
  totals.score = qualityScore({ visits: totals.visits, shelfVisits: totals.shelf_visits, priceVisits: totals.price_visits, priceEntries: totals.price_entries, flaggedEntries: totals.flagged_entries });
  const flagged = inPeriod.filter((e) => e.flags.length).slice(0, flaggedLimit);
  return { days, reps, totals, flagged, meta: aggregateMeta(inPeriod) };
}
