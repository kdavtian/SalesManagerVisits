// Competitor price index (owner, 2026-11-26): for each product line and volume, the median wholesale and retail of every competitor brand
// (clean entries of the last 90 days, priceRules.js) beside our matching Castrol products' prices per tier, the gap in %, the shop's
// margin per brand against the margin our recommended retail leaves, a monthly trend, and the month-on-month drops that alert management.
import { pool } from "../../db/pool.js";
import { autoLineCode, sizeOf } from "../../customers/volumeActuals.js";
import { loadPriceEntries } from "./marketPrices.js";
import { median, isClean, aggregateMeta } from "./priceRules.js";

export const INDEX_DAYS = 90;
export const TREND_MONTHS = 6;
// an alert: a brand's monthly median fell by more than this share, both months resting on at least DROP_MIN_ENTRIES clean prices
export const DROP_PCT = 5;
export const DROP_MIN_ENTRIES = 2;

const yerevanMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Yerevan", year: "numeric", month: "2-digit" });
// "2026-11" (Yerevan calendar)
export const monthOf = (d) => yerevanMonth.format(new Date(d)).slice(0, 7);
export function addMonth(month, n) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const pctDiff = (a, b) => (a == null || !(b > 0) ? null : Math.round(((a - b) / b) * 100));
const volKey = (v) => Number(v).toFixed(3);

// Our Castrol products placed on a line and a volume: management's own mapping (volume_potential_sku_map) first, else the line rules of
// volumeActuals.js; the volume from the mapping, the product's size or its unit text. -> [{ id, name, line_code, volume, bronze, silver, gold, retail }]
export async function ourProducts(db = pool) {
  const [{ rows: products }, { rows: lines }, { rows: decided }] = await Promise.all([
    db.query(
      `SELECT id, name, brand, family, unit, size_l::float8 AS size_l, lower(erp_product_id) AS sku_key,
              bronze_price_amd::float8 AS bronze, silver_price_amd::float8 AS silver, gold_price_amd::float8 AS gold, retail_price_amd::float8 AS retail
       FROM products WHERE active AND lower(trim(brand)) = 'castrol'`
    ),
    db.query("SELECT id, code FROM volume_potential_lines"),
    db.query("SELECT sku_key, line_id, not_a_line, litres_per_unit::float8 AS litres_per_unit FROM volume_potential_sku_map"),
  ]);
  const codeOf = new Map(lines.map((l) => [l.id, l.code]));
  const known = new Set(lines.map((l) => l.code));
  const manual = new Map(decided.map((d) => [d.sku_key, d]));
  const out = [];
  for (const p of products) {
    const m = p.sku_key ? manual.get(p.sku_key) : null;
    if (m?.not_a_line) continue;
    const code = m?.line_id ? codeOf.get(m.line_id) : autoLineCode(p).code;
    const volume = m?.litres_per_unit ?? (p.size_l > 0 ? p.size_l : sizeOf(p.unit));
    if (!code || !known.has(code) || !volume) continue;
    const round = (v) => (v == null ? null : Math.round(v));
    out.push({ id: p.id, name: p.name, line_code: code, volume, bronze: round(p.bronze), silver: round(p.silver), gold: round(p.gold), retail: round(p.retail) });
  }
  return out;
}

// Pure: the index from flagged entries (priceRules.flagEntries) and our products. now decides the 90-day window and the trend months.
export function buildIndex(entries, ours, { now = new Date(), days = INDEX_DAYS, lines = [] } = {}) {
  const since = new Date(now.getTime() - days * 86400000);
  const clean = entries.filter(isClean);
  const recent = clean.filter((e) => new Date(e.recorded_at) >= since);
  const thisMonth = monthOf(now);
  const months = Array.from({ length: TREND_MONTHS }, (_, i) => addMonth(thisMonth, i - TREND_MONTHS + 1));
  const lineInfo = new Map(lines.map((l) => [l.code, l]));

  const groups = new Map();
  const groupOf = (line_code, volume, unit) => {
    const k = `${line_code}|${volKey(volume)}`;
    if (!groups.has(k)) groups.set(k, { line_code, volume: Number(volume), unit, brands: new Map(), ours: [], entries: [] });
    return groups.get(k);
  };
  for (const e of recent) {
    const g = groupOf(e.line_code, e.volume, e.unit);
    g.entries.push(e);
    if (!g.brands.has(e.brand_key)) g.brands.set(e.brand_key, { brand_key: e.brand_key, brand_name: e.brand_name, entries: [] });
    g.brands.get(e.brand_key).entries.push(e);
  }
  // our products only where a competitor price exists to compare with
  for (const p of ours) {
    const g = groups.get(`${p.line_code}|${volKey(p.volume)}`);
    if (g) g.ours.push(p);
  }
  // monthly medians (per litre wholesale, else retail) for the trend, over every clean entry of the last TREND_MONTHS months
  const monthly = new Map();
  for (const e of clean) {
    const m = monthOf(e.recorded_at);
    if (!months.includes(m)) continue;
    const k = `${e.line_code}|${volKey(e.volume)}|${e.brand_key}|${m}`;
    if (!monthly.has(k)) monthly.set(k, []);
    monthly.get(k).push(e);
  }

  const out = [...groups.values()].map((g) => {
    const reference = g.ours.length ? g.ours.reduce((a, b) => ((b.bronze ?? Infinity) < (a.bronze ?? Infinity) ? b : a)) : null;
    const brands = [...g.brands.values()].map((b) => {
      const wholesale = median(b.entries.map((e) => e.wholesale_amd));
      const retail = median(b.entries.map((e) => e.retail_amd));
      const margin = median(b.entries.filter((e) => e.wholesale_amd != null && e.retail_amd != null).map((e) => e.retail_amd - e.wholesale_amd));
      const trend = months.map((m) => {
        const list = monthly.get(`${g.line_code}|${volKey(g.volume)}|${b.brand_key}|${m}`) ?? [];
        return { month: m, wholesale: median(list.map((e) => e.wholesale_amd)), retail: median(list.map((e) => e.retail_amd)), entries: list.length };
      });
      return {
        brand_key: b.brand_key,
        brand_name: b.brand_name,
        wholesale,
        retail,
        margin,
        margin_pct: pctDiff(retail, wholesale),
        // our cheapest matching product (Bronze) against this brand: + = we are dearer
        gap_wholesale_pct: reference ? pctDiff(reference.bronze, wholesale) : null,
        gap_retail_pct: reference ? pctDiff(reference.retail, retail) : null,
        trend,
        meta: aggregateMeta(b.entries),
      };
    });
    brands.sort((a, b) => b.meta.shops - a.meta.shops || b.meta.entries - a.meta.entries || String(a.brand_name).localeCompare(String(b.brand_name)));
    const info = lineInfo.get(g.line_code) ?? {};
    return {
      line_code: g.line_code,
      line_name_en: info.name_en ?? g.line_code,
      line_name_hy: info.name_hy ?? g.line_code,
      group_key: info.group_key ?? null,
      sort_order: info.sort_order ?? 999,
      volume: g.volume,
      unit: g.unit,
      brands,
      ours: g.ours
        .map((p) => ({ ...p, margin_bronze: p.retail != null && p.bronze != null ? p.retail - p.bronze : null, margin_pct: pctDiff(p.retail, p.bronze) }))
        .sort((a, b) => (a.bronze ?? Infinity) - (b.bronze ?? Infinity)),
      reference_id: reference?.id ?? null,
      meta: aggregateMeta(g.entries),
    };
  });
  out.sort((a, b) => a.sort_order - b.sort_order || a.line_code.localeCompare(b.line_code) || a.volume - b.volume);
  return { days, months, groups: out, meta: aggregateMeta(recent) };
}

// Pure: brands whose monthly median (per unit; wholesale, else retail) fell more than DROP_PCT from `month - 1` to `month`.
// -> [{ brand_key, brand_name, line_code, line_name_hy, volume, unit, kind, before, after, change_pct, entries }]
export function priceDrops(entries, month, { lines = [] } = {}) {
  const prev = addMonth(month, -1);
  const byKey = new Map();
  for (const e of entries.filter(isClean)) {
    const m = monthOf(e.recorded_at);
    if (m !== month && m !== prev) continue;
    const k = `${e.brand_key}|${e.line_code}|${volKey(e.volume)}`;
    if (!byKey.has(k)) byKey.set(k, { e, [month]: [], [prev]: [] });
    byKey.get(k)[m].push(e);
  }
  const name = new Map(lines.map((l) => [l.code, l.name_hy]));
  const out = [];
  for (const g of byKey.values()) {
    for (const kind of ["wholesale", "retail"]) {
      const a = g[prev].filter((e) => e[`${kind}_amd`] != null);
      const b = g[month].filter((e) => e[`${kind}_amd`] != null);
      if (a.length < DROP_MIN_ENTRIES || b.length < DROP_MIN_ENTRIES) continue;
      const before = median(a.map((e) => e[`${kind}_amd`]));
      const after = median(b.map((e) => e[`${kind}_amd`]));
      const change = ((after - before) / before) * 100;
      if (change < -DROP_PCT) {
        out.push({ brand_key: g.e.brand_key, brand_name: g.e.brand_name, line_code: g.e.line_code, line_name_hy: name.get(g.e.line_code) ?? g.e.line_code, volume: Number(g.e.volume), unit: g.e.unit, kind, before, after, change_pct: Math.round(change), entries: a.length + b.length });
        break; // one line per brand / line / volume: wholesale first
      }
    }
  }
  return out.sort((x, y) => x.change_pct - y.change_pct);
}

export async function marketLines(db = pool) {
  return (await db.query("SELECT code, group_key, name_en, name_hy, unit, sort_order FROM volume_potential_lines")).rows;
}

export async function priceIndex({ days = INDEX_DAYS, now = new Date(), db = pool } = {}) {
  const [entries, ours, lines] = await Promise.all([loadPriceEntries({ db }), ourProducts(db), marketLines(db)]);
  const index = buildIndex(entries, ours, { now, days, lines });
  const month = monthOf(now);
  // the drops of the last whole month (what the alert sent) and of the month so far
  return { ...index, drops: { last_month: priceDrops(entries, addMonth(month, -1), { lines }), this_month: priceDrops(entries, month, { lines }) } };
}
