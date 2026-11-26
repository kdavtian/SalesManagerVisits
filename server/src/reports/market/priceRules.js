// Market data rules (owner, 2026-11-26: "the data reps record is not usable yet"). Pure functions, no database: the one place that says
// what a usable competitor price is, so every market report (price index, product card, monthly summary) cleans prices the same way.
//
// - A price is compared per litre (per kg for grease, the line's unit): wholesale_amd / volume, whole AMD.
// - An entry is FLAGGED (kept, but left out of medians) when its retail is below its wholesale, or one of its prices is more than
//   OUTLIER_RATIO times (or less than 1 / OUTLIER_RATIO of) the median of the same brand, line and volume. A median needs at least
//   MIN_GROUP entries: with one or two prices there is nothing to call normal, so nothing is flagged for being far from it.
// - Every aggregate carries how fresh it is (latest date) and how many shops it rests on, so nobody reads one shop's price as "the market".

export const OUTLIER_RATIO = 3;
export const MIN_GROUP = 3;
export const FLAGS = ["retail_below_wholesale", "wholesale_high", "wholesale_low", "retail_high", "retail_low"];

// amount for one litre (kg); null when there is no amount or no volume
export function perUnit(amount, volume) {
  const a = amount === null || amount === undefined ? NaN : Number(amount);
  const v = Number(volume);
  if (!Number.isFinite(a) || !(v > 0)) return null;
  return Math.round(a / v);
}

// median of the finite numbers (null when there are none); the mean of the two middle ones for an even count, whole AMD
export function median(values) {
  const nums = values.filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = nums.length >> 1;
  return Math.round(nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2);
}

export const groupKey = (e) => `${e.brand_key}|${e.line_code}|${Number(e.volume)}`;

const farFrom = (value, mid) => (value === null || value === undefined || !(mid > 0) ? null : value > mid * OUTLIER_RATIO ? "high" : value < mid / OUTLIER_RATIO ? "low" : null);

// entries: [{ brand_key, line_code, volume, unit, wholesale_amd, retail_amd, ... }] -> the same entries (new objects) plus
// wholesale_per_unit, retail_per_unit, flags (array of FLAGS, empty = clean). The medians are taken over the entries given (the caller
// chooses the window), the entry itself included, entries with retail below wholesale left out.
export function flagEntries(entries) {
  const groups = new Map();
  for (const e of entries) {
    const k = groupKey(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  // an entry wrong on its own (retail below wholesale) is no yardstick for the others (Codex review): left out before the medians
  const inverted = (e) => e.wholesale_amd != null && e.retail_amd != null && Number(e.retail_amd) < Number(e.wholesale_amd);
  const mids = new Map();
  for (const [k, all] of groups) {
    const list = all.filter((e) => !inverted(e));
    const mid = (field) => {
      const vals = list.map((e) => e[field]).filter((v) => v != null);
      return vals.length >= MIN_GROUP ? median(vals) : null;
    };
    mids.set(k, { wholesale: mid("wholesale_amd"), retail: mid("retail_amd") });
  }
  return entries.map((e) => {
    const mid = mids.get(groupKey(e));
    const flags = [];
    if (inverted(e)) flags.push("retail_below_wholesale");
    const w = farFrom(e.wholesale_amd == null ? null : Number(e.wholesale_amd), mid.wholesale);
    if (w) flags.push(`wholesale_${w}`);
    const r = farFrom(e.retail_amd == null ? null : Number(e.retail_amd), mid.retail);
    if (r) flags.push(`retail_${r}`);
    return { ...e, wholesale_per_unit: perUnit(e.wholesale_amd, e.volume), retail_per_unit: perUnit(e.retail_amd, e.volume), flags };
  });
}

export const isClean = (e) => !e.flags?.length;

// freshness and support of an aggregate: { latest_at (ISO string or null), shops (distinct customers), entries }
export function aggregateMeta(entries, { at = "recorded_at", shop = "customer_id" } = {}) {
  let latest = null;
  const shops = new Set();
  for (const e of entries) {
    const d = e[at] ? new Date(e[at]) : null;
    if (d && !Number.isNaN(d.getTime()) && (!latest || d > latest)) latest = d;
    if (e[shop] != null) shops.add(e[shop]);
  }
  return { latest_at: latest ? latest.toISOString() : null, shops: shops.size, entries: entries.length };
}

// The data-quality score of one rep, 0..100: how much of the visits' market data management can use.
//   60 points: share of visits that recorded the shelf; 40 points: share of visits with at least one competitor price, reduced by the
//   share of that rep's price entries that were flagged (a wrong price is worth less than none). null without visits.
export function qualityScore({ visits, shelfVisits, priceVisits, priceEntries, flaggedEntries }) {
  if (!(visits > 0)) return null;
  const shelf = Math.min(1, shelfVisits / visits);
  const prices = Math.min(1, priceVisits / visits);
  const flagged = priceEntries > 0 ? Math.min(1, flaggedEntries / priceEntries) : 0;
  return Math.round(60 * shelf + 40 * prices * (1 - flagged));
}
