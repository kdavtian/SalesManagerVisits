// Shelf share (owner, 2026-11-26): of the visited shops, how many carry Castrol and each competitor (numeric distribution), and the same
// weighted by the shops' monthly litres potential (weighted distribution), per region and sales channel, with a monthly trend; plus the
// shops where fake or grey-imported Castrol was seen. The shelf of a shop is, per brand group (castrol / lotos / royal / competitors),
// the latest visit that recorded that group, if not older than SHELF_FRESH_DAYS (field/shelfData.js) at the date looked at.
import { pool } from "../../db/pool.js";
import { SHELF_FRESH_DAYS, SHELF_GROUPS } from "../../field/shelfData.js";
import { monthOf, addMonth, TREND_MONTHS } from "./priceIndex.js";

const DAY = 86400000;
const GENUINE = new Set(["available", "full_range"]);
const GREY = new Set(["imported_us", "imported_dubai", "imported_ru", "imported_other"]);
// the brand keys of the result: genuine Castrol, then fake and grey Castrol, our sister brands, then each competitor key
export const CASTROL = "castrol";
export const CASTROL_FAKE = "castrol_fake";
export const CASTROL_GREY = "castrol_grey";

// Pure: the brands one shop's shelf state carries. state: { castrol: [...values], lotos: [...], royal: [...], competitors: [keys] }
export function brandsOn(state) {
  const out = new Set();
  const c = state.castrol ?? [];
  if (c.some((v) => GENUINE.has(v))) out.add(CASTROL);
  if (c.includes("fake")) out.add(CASTROL_FAKE);
  if (c.some((v) => GREY.has(v))) out.add(CASTROL_GREY);
  for (const g of ["lotos", "royal"]) if ((state[g] ?? []).some((v) => GENUINE.has(v))) out.add(g);
  for (const k of state.competitors ?? []) out.add(k);
  return out;
}

// Pure: every shop's shelf state on `asOf`: per group, the latest record in (asOf - fresh days, asOf]. records: [{ customer_id, at, group,
// values }] -> Map(customer_id -> { state, at (latest record used) })
export function shelfStateAt(records, asOf, freshDays = SHELF_FRESH_DAYS) {
  const end = new Date(asOf).getTime();
  const start = end - freshDays * DAY;
  const best = new Map();
  for (const r of records) {
    const t = new Date(r.at).getTime();
    if (t > end || t <= start) continue;
    const key = `${r.customer_id}|${r.group}`;
    const cur = best.get(key);
    if (!cur || t > cur.t || (t === cur.t && r.id > cur.r.id)) best.set(key, { t, r });
  }
  const shops = new Map();
  for (const { t, r } of best.values()) {
    const s = shops.get(r.customer_id) ?? { state: {}, at: 0 };
    s.state[r.group] = r.values;
    s.at = Math.max(s.at, t);
    shops.set(r.customer_id, s);
  }
  return shops;
}

// Pure: numeric and weighted distribution of each brand over the shops given. shops: [{ customer_id, potential, brands: Set }]
// -> { shops, weighted_base, brands: [{ key, shops, numeric_pct, potential, weighted_pct }] } most shops first
export function distribution(shops) {
  const base = shops.reduce((s, x) => s + (x.potential > 0 ? x.potential : 0), 0);
  const by = new Map();
  for (const s of shops) {
    for (const k of s.brands) {
      const b = by.get(k) ?? { key: k, shops: 0, potential: 0 };
      b.shops += 1;
      b.potential += s.potential > 0 ? s.potential : 0;
      by.set(k, b);
    }
  }
  const pct = (a, b) => (b > 0 ? Math.round((100 * a) / b) : null);
  const brands = [...by.values()]
    .map((b) => ({ ...b, potential: Math.round(b.potential), numeric_pct: pct(b.shops, shops.length), weighted_pct: pct(b.potential, base) }))
    .sort((a, b) => b.shops - a.shops || a.key.localeCompare(b.key));
  return { shops: shops.length, weighted_base: Math.round(base), brands };
}

const castrolOf = (d) => d.brands.find((b) => b.key === CASTROL) ?? { shops: 0, numeric_pct: d.shops ? 0 : null, weighted_pct: d.weighted_base ? 0 : null };

// Pure: everything the report shows, from the shelf records and the shops. shops: Map(customer_id -> { name, region, sales_channel,
// potential, rep_name }); filter: { region, channel }.
export function buildShelfShare(records, shopInfo, { now = new Date(), filter = {}, names = new Map() } = {}) {
  const keep = (id) => {
    const s = shopInfo.get(id);
    return s && (!filter.region || s.region === filter.region) && (!filter.channel || s.sales_channel === filter.channel);
  };
  const rowsAt = (asOf) =>
    [...shelfStateAt(records, asOf)]
      .filter(([id]) => keep(id))
      .map(([id, s]) => ({ customer_id: id, at: s.at, state: s.state, potential: shopInfo.get(id).potential, brands: brandsOn(s.state) }));
  const current = rowsAt(now);
  const total = distribution(current);
  const groupBy = (field) => {
    const m = new Map();
    for (const r of current) {
      const k = shopInfo.get(r.customer_id)[field] ?? "";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return [...m]
      .map(([key, list]) => {
        const d = distribution(list);
        const c = castrolOf(d);
        const top = d.brands.find((b) => ![CASTROL, CASTROL_FAKE, CASTROL_GREY, "lotos", "royal"].includes(b.key));
        return { key, shops: d.shops, castrol_pct: c.numeric_pct, castrol_weighted_pct: c.weighted_pct, fake_grey: list.filter((r) => r.brands.has(CASTROL_FAKE) || r.brands.has(CASTROL_GREY)).length, top_competitor: top ? { key: top.key, numeric_pct: top.numeric_pct } : null };
      })
      .sort((a, b) => b.shops - a.shops || String(a.key).localeCompare(String(b.key)));
  };
  // month ends: the last TREND_MONTHS months, the current one as of now
  const thisMonth = monthOf(now);
  const trend = Array.from({ length: TREND_MONTHS }, (_, i) => addMonth(thisMonth, i - TREND_MONTHS + 1)).map((month) => {
    const end = month === thisMonth ? now : new Date(`${addMonth(month, 1)}-01T00:00:00+04:00`);
    const d = distribution(rowsAt(end));
    const c = castrolOf(d);
    return { month, shops: d.shops, castrol_pct: c.numeric_pct, castrol_weighted_pct: c.weighted_pct };
  });
  const flagged = current
    .filter((r) => r.brands.has(CASTROL_FAKE) || r.brands.has(CASTROL_GREY))
    .map((r) => {
      const s = shopInfo.get(r.customer_id);
      return { customer_id: r.customer_id, name: s.name, region: s.region, rep_name: s.rep_name, at: new Date(r.at).toISOString(), fake: r.brands.has(CASTROL_FAKE), values: (r.state.castrol ?? []).filter((v) => v === "fake" || GREY.has(v)) };
    })
    .sort((a, b) => Number(b.fake) - Number(a.fake) || b.at.localeCompare(a.at));
  const latest = current.reduce((m, r) => Math.max(m, r.at), 0);
  return {
    fresh_days: SHELF_FRESH_DAYS,
    totals: { ...total, brands: total.brands.map((b) => ({ ...b, name: names.get(b.key) ?? null })) },
    by_region: groupBy("region"),
    by_channel: groupBy("sales_channel"),
    trend,
    flagged,
    meta: { latest_at: latest ? new Date(latest).toISOString() : null, shops: current.length, entries: current.length },
  };
}

// The shelf records (one per visit and brand group) from TREND_MONTHS + fresh days ago, the shops with their potential (the total monthly
// need, else the sum of the litre lines, as volumeActuals.walletOf), and the competitor names.
export async function shelfShare({ now = new Date(), region = null, channel = null, db = pool } = {}) {
  const since = new Date(now.getTime() - ((TREND_MONTHS + 1) * 31 + SHELF_FRESH_DAYS) * DAY);
  const [{ rows: records }, { rows: shops }, { rows: brands }] = await Promise.all([
    db.query(
      `SELECT ch.id, ch.customer_id, ch.timestamp AS at, g.key AS "group", ARRAY(SELECT jsonb_array_elements_text(g.value)) AS values
       FROM checkins ch CROSS JOIN LATERAL jsonb_each(ch.brand_status) g
       WHERE ch.brand_status IS NOT NULL AND ch.timestamp >= $1 AND ch.timestamp <= $2 AND g.key = ANY($3::text[]) AND jsonb_typeof(g.value) = 'array'`,
      [since, now, SHELF_GROUPS]
    ),
    db.query(
      `SELECT c.id, c.name, c.region, c.sales_channel, COALESCE(u.name_hy, u.name) AS rep_name,
              COALESCE(NULLIF(c.expected_volume_l, 0),
                       (SELECT sum(a.amount_month) FROM volume_potential_amounts a JOIN volume_potential_lines l ON l.id = a.line_id AND l.unit = 'L' WHERE a.customer_id = c.id))::float8 AS potential
       FROM customers c LEFT JOIN users u ON u.id = c.assigned_manager_id
       WHERE NOT c.checkin_for_all AND c.id IN (SELECT DISTINCT customer_id FROM checkins WHERE brand_status IS NOT NULL AND timestamp >= $1)`,
      [since]
    ),
    db.query("SELECT key, name FROM competitor_brands"),
  ]);
  const info = new Map(shops.map((s) => [s.id, s]));
  const result = buildShelfShare(records, info, { now, filter: { region, channel }, names: new Map(brands.map((b) => [b.key, b.name])) });
  // the filter choices: every region and channel with fresh shelf data, before the filter
  const all = [...shelfStateAt(records, now).keys()].map((id) => info.get(id)).filter(Boolean);
  result.regions = [...new Set(all.map((s) => s.region).filter(Boolean))].sort();
  result.channels = [...new Set(all.map((s) => s.sales_channel).filter(Boolean))].sort();
  return result;
}
