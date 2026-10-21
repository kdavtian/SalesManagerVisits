// KAD OS <-> KAD Motors: the "app order" rules (owner, 2026-10-21).
// A customer that runs KAD OS has a KAD user account linked to it (partner_links). Orders that account places are app orders and get:
//   - a flat discount (default 2 %) on every line not already covered by a campaign price,
//   - queue priority + an APP badge for the staff,
//   - a delivery promise date (target only, nothing is enforced),
//   - the supplier's campaigns / bundles (line-level prices), which only exist for app orders,
// and the customer sees progress (levels, streak, savings) that rewards ordering through the app.
// All numbers live in app_settings.app_orders (App configuration); this file holds the pure rules and the SQL helpers.
import { pool } from "./db/pool.js";
import { tierListPrice } from "./tierPricing.js";
import { netCostAtPrice } from "./discountPolicy.js";
import { isWorkingDayOfWeek } from "./workingDays.js";
import { yerevanToday, yerevanMonthBounds, yerevanWeekBounds, yerevanTimeOfDay, yerevanDateOf } from "./utils/yerevanDate.js";

export const APP_ORDER_DEFAULTS = Object.freeze({
  discount_enabled: true,
  discount_pct: 2,
  priority_enabled: true,
  promise_enabled: true,
  promise_working_days: 2,
  promise_cutoff_hour: 15,
  progress_enabled: true,
  levels: [1, 3, 6, 10],
  // Vaghinak chases an app order that waits too long: after this many hours without confirmation (pack / deliver: half of the usual limit).
  chase_enabled: true,
  chase_confirm_hours: 2,
});

export function normalizeSettings(raw) {
  const s = { ...APP_ORDER_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  s.levels = Array.isArray(s.levels) && s.levels.length === 4 ? s.levels.map(Number) : [...APP_ORDER_DEFAULTS.levels];
  return s;
}

// Validates a PUT body (only the keys sent are changed). Returns { value } or { error }.
export function validateSettingsPatch(patch) {
  const out = {};
  const bool = (k) => {
    if (patch[k] === undefined) return null;
    if (typeof patch[k] !== "boolean") return `${k} must be true or false`;
    out[k] = patch[k];
    return null;
  };
  const num = (k, min, max, integer) => {
    if (patch[k] === undefined) return null;
    const n = Number(patch[k]);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) return `${k} must be ${integer ? "a whole number" : "a number"} between ${min} and ${max}`;
    out[k] = n;
    return null;
  };
  const errors = [
    bool("discount_enabled"), num("discount_pct", 0, 10, false),
    bool("priority_enabled"),
    bool("promise_enabled"), num("promise_working_days", 0, 10, true), num("promise_cutoff_hour", 0, 23, true),
    bool("progress_enabled"),
    bool("chase_enabled"), num("chase_confirm_hours", 1, 48, true),
  ].filter(Boolean);
  if (patch.levels !== undefined) {
    const lv = patch.levels;
    const ok = Array.isArray(lv) && lv.length === 4 && lv.every((n, i) => Number.isInteger(n) && n >= 1 && n <= 100 && (i === 0 || n > lv[i - 1]));
    if (ok) out.levels = lv;
    else errors.push("levels must be 4 whole numbers (orders per month), each bigger than the one before");
  }
  return errors.length ? { error: errors[0] } : { value: out };
}

export async function getAppOrderSettings(db = pool) {
  const { rows } = await db.query("SELECT app_orders FROM app_settings WHERE id = 1");
  return normalizeSettings(rows[0]?.app_orders);
}

export async function saveAppOrderSettings(patch, db = pool) {
  const cur = await getAppOrderSettings(db);
  const next = { ...cur, ...patch };
  await db.query(
    `INSERT INTO app_settings (id, app_orders) VALUES (1, $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET app_orders = EXCLUDED.app_orders`,
    [JSON.stringify(next)]
  );
  return { before: cur, after: next };
}

// Is this user a KAD OS install's account? Asked on every authenticated request, so the answer is remembered for 30 s (a link or unlink clears it).
const partnerCache = new Map(); // user id -> { partner, at }
export function forgetPartnerCache() {
  partnerCache.clear();
}
export async function isPartnerAccount(userId, db = pool) {
  const hit = partnerCache.get(userId);
  if (hit && Date.now() - hit.at < 30000) return hit.partner;
  const { rows } = await db.query("SELECT 1 FROM partner_links WHERE user_id = $1", [userId]);
  partnerCache.set(userId, { partner: rows.length > 0, at: Date.now() });
  return rows.length > 0;
}
// A KAD OS account holds a login that lives on a customer's server, so it can do nothing in KAD except what a customer's ERP needs: the partner
// API, signing in/out, and (for older KAD OS versions) placing an order through POST /api/orders.
export function partnerMayUse(req) {
  const base = req.baseUrl || "";
  if (base.startsWith("/api/partner") || base.startsWith("/api/auth")) return true;
  return base === "/api/orders" && req.method === "POST" && (req.path === "/" || req.path === "");
}

/** The customer a KAD user account is linked to (null for an ordinary user). */
export async function partnerLinkFor(userId, db = pool) {
  const { rows } = await db.query("SELECT customer_id FROM partner_links WHERE user_id = $1", [userId]);
  return rows[0] ? { customerId: rows[0].customer_id } : null;
}

// ---- delivery promise -----------------------------------------------------------------------------------------------
// The target date: `days` working days after the order (Sunday and company holidays do not count). An order placed after the
// cut-off hour, or on a non-working day, counts from the next working day. days = 0 means "the same working day".
export function computePromisedDate(now, { promise_working_days: days, promise_cutoff_hour: cutoff }, holidays = new Set()) {
  const isWorking = (ymd) => isWorkingDayOfWeek(new Date(`${ymd}T00:00:00Z`)) && !holidays.has(ymd);
  const addDay = (ymd) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
  let day = yerevanToday(now);
  const hour = Number(yerevanTimeOfDay(now).slice(0, 2));
  // The starting working day: today when it is one and the cut-off has not passed, otherwise the next one.
  if (!isWorking(day) || hour >= cutoff) {
    do day = addDay(day); while (!isWorking(day));
  }
  for (let left = days; left > 0; left -= 1) {
    do day = addDay(day); while (!isWorking(day));
  }
  return day;
}

export async function promisedDateFor(now, settings, db = pool) {
  if (!settings.promise_enabled) return null;
  const from = yerevanToday(now);
  const to = new Date(new Date(`${from}T00:00:00Z`).getTime() + 40 * 86400000).toISOString().slice(0, 10);
  const { rows } = await db.query("SELECT holiday_date FROM company_holidays WHERE holiday_date BETWEEN $1 AND $2", [from, to]);
  return computePromisedDate(now, settings, new Set(rows.map((r) => r.holiday_date.toISOString().slice(0, 10))));
}

// ---- campaigns ------------------------------------------------------------------------------------------------------
/** Campaigns running now for one customer (all-audience ones plus the ones that list the customer), with their products. */
export async function activeCampaignsFor(customerId, now = new Date(), db = pool) {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.note, c.kind, c.percent::float AS percent, c.starts_at, c.ends_at, c.audience
       FROM campaigns c
      WHERE NOT c.paused AND c.starts_at <= $2 AND c.ends_at > $2
        AND (c.audience = 'all' OR EXISTS (SELECT 1 FROM campaign_customers cc WHERE cc.campaign_id = c.id AND cc.customer_id = $1))
      ORDER BY c.ends_at, c.id`,
    [customerId, now]
  );
  if (!rows.length) return [];
  const { rows: prods } = await db.query(
    `SELECT cp.campaign_id, cp.product_id, cp.min_qty, p.name, p.brand, p.unit AS size
       FROM campaign_products cp JOIN products p ON p.id = cp.product_id
      WHERE cp.campaign_id = ANY($1) ORDER BY p.brand NULLS LAST, p.name`,
    [rows.map((r) => r.id)]
  );
  return rows.map((c) => ({ ...c, products: prods.filter((p) => p.campaign_id === c.id).map(({ campaign_id, ...p }) => p) }));
}

// lines: [{ product_id, quantity, unit_price_amd, line_total_amd, ... }] at list (tier) prices. Returns NEW lines; a line that a campaign
// covers gets the best (biggest) percent among the campaigns that apply, its campaign_id and the list price it started from.
// discount: any listed product line with quantity >= min_qty. bundle: only when EVERY listed product is in the order at >= its min_qty.
export function applyCampaigns(lines, campaigns) {
  const qty = new Map();
  for (const l of lines) qty.set(Number(l.product_id), (qty.get(Number(l.product_id)) ?? 0) + Number(l.quantity));
  const best = new Map(); // product_id -> { percent, campaign_id }
  for (const c of campaigns) {
    const met = c.products.filter((p) => (qty.get(Number(p.product_id)) ?? 0) >= p.min_qty);
    const applies = c.kind === "bundle" ? c.products.length > 0 && met.length === c.products.length : met.length > 0;
    if (!applies) continue;
    for (const p of met) {
      const cur = best.get(Number(p.product_id));
      if (!cur || c.percent > cur.percent) best.set(Number(p.product_id), { percent: c.percent, campaign_id: c.id });
    }
  }
  return lines.map((l) => {
    const hit = best.get(Number(l.product_id));
    if (!hit) return { ...l, campaign_id: null, list_price_amd: null };
    const price = Math.round(Number(l.unit_price_amd) * (1 - hit.percent / 100));
    return { ...l, list_price_amd: Number(l.unit_price_amd), unit_price_amd: price, line_total_amd: price * Number(l.quantity), campaign_id: hit.campaign_id };
  });
}

/** Flat AMD discount for the lines no campaign covers (campaign price replaces the app discount, they never stack). */
export function appDiscountAmd(lines, pct) {
  if (!(pct > 0)) return 0;
  const base = lines.filter((l) => !l.campaign_id).reduce((sum, l) => sum + Number(l.line_total_amd), 0);
  return Math.floor((base * pct) / 100);
}

/**
 * Prices an app order: campaigns first, then the app discount on the rest. `at` is the moment campaigns are judged at (now for a new
 * order, the creation time when staff edit an existing one).
 */
export async function priceAppOrderLines(customerId, lines, { at = new Date(), settings = null, db = pool } = {}) {
  const s = settings ?? (await getAppOrderSettings(db));
  const campaigns = await activeCampaignsFor(customerId, at, db);
  const priced = applyCampaigns(lines, campaigns);
  const discountPct = s.discount_enabled ? s.discount_pct : 0;
  return { lines: priced, discountAmd: appDiscountAmd(priced, discountPct), discountPct, settings: s };
}

// A campaign must never push a line under what it costs us. For each product and each tier it can reach (all tiers for an
// all-customers campaign, the selected customers' tiers otherwise) the campaign price is compared with net cost and landing cost.
// Returns the product names that would sell too cheap (empty = fine).
export async function campaignBelowCost({ percent, productIds, customerIds = null }, db = pool) {
  if (!productIds.length) return [];
  const { rows: products } = await db.query("SELECT * FROM products WHERE id = ANY($1)", [productIds]);
  let tiers = ["bronze", "silver", "gold"];
  if (customerIds) {
    const { rows } = await db.query("SELECT DISTINCT COALESCE(customer_tier, 'bronze') AS tier FROM customers WHERE id = ANY($1)", [customerIds]);
    tiers = rows.map((r) => r.tier);
    if (!tiers.length) tiers = ["bronze"];
  }
  const bad = [];
  for (const p of products) {
    const landing = Number(p.landing_cost_amd) || 0;
    for (const tier of tiers) {
      const list = tierListPrice(p, tier);
      if (!(list > 0)) continue;
      const price = Math.round(list * (1 - percent / 100));
      const net = Number(p.net_cost_amd) > 0 ? netCostAtPrice(p, price) : 0;
      if ((net > 0 && price < net - 0.5) || (landing > 0 && price < landing - 0.5)) {
        bad.push(p.name);
        break;
      }
    }
  }
  return bad;
}

// ---- statuses -------------------------------------------------------------------------------------------------------
// What the customer sees: received -> confirmed -> packed -> on_the_way -> delivered (+ on_hold when the order went back to review).
// "On the way" = packed and already on a delivery route (the driver has it in their list).
export const PARTNER_STEPS = ["received", "confirmed", "packed", "on_the_way", "delivered"];
export function partnerStatus(status, onRoute) {
  switch (status) {
    case "submitted": return "received";
    case "confirmed": return "confirmed";
    case "packed_stock_out": return onRoute ? "on_the_way" : "packed";
    case "delivered": return "delivered";
    default: return "on_hold"; // draft: sent back for a correction
  }
}

// ---- progress (gamification) ----------------------------------------------------------------------------------------
// Orders placed through the app this Yerevan month decide the level; consecutive Yerevan weeks with at least one app order are the
// streak; "saved" adds up the app discount and campaign savings. The share compares app orders with all the customer's orders (90 days).
export function levelProgress(count, levels) {
  let level = 0;
  for (let i = 0; i < levels.length; i += 1) if (count >= levels[i]) level = i + 1;
  const next = level < levels.length ? levels[level] : null;
  const prev = level > 0 ? levels[level - 1] : 0;
  return {
    level, // 0 = no level yet, 1..4
    orders_this_month: count,
    next_level: next === null ? null : level + 1,
    next_at: next,
    remaining: next === null ? 0 : next - count,
    pct: next === null ? 100 : Math.max(0, Math.min(100, Math.round(((count - prev) / (next - prev)) * 100))),
  };
}

export function streakWeeks(weekStarts, thisWeekStart) {
  const set = new Set(weekStarts);
  const step = (ymd, weeks) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + weeks * 7 * 86400000).toISOString().slice(0, 10);
  // The running week does not break the streak while it is still young: start from last week when this week has no order yet.
  let cursor = set.has(thisWeekStart) ? thisWeekStart : step(thisWeekStart, -1);
  let n = 0;
  while (set.has(cursor)) {
    n += 1;
    cursor = step(cursor, -1);
  }
  return { weeks: n, active_this_week: set.has(thisWeekStart) };
}

export async function appProgress(customerId, settings, now = new Date(), db = pool) {
  const { startAt, endAt } = yerevanMonthBounds(now);
  const { rows: m } = await db.query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(o.discount_amd) FILTER (WHERE o.placed_via_app), 0)::float AS app_discount,
            COALESCE(SUM((SELECT COALESCE(SUM((oi.list_price_amd - oi.unit_price_amd) * oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id AND oi.campaign_id IS NOT NULL)), 0)::float AS campaign_saved
       FROM orders o WHERE o.customer_id = $1 AND o.placed_via_app AND o.created_at >= $2 AND o.created_at < $3`,
    [customerId, startAt, endAt]
  );
  const week = yerevanWeekBounds(now);
  const since = new Date(week.startAt.getTime() - 26 * 7 * 86400000);
  const { rows: weeks } = await db.query(
    `SELECT DISTINCT to_char(date_trunc('week', o.created_at AT TIME ZONE 'Asia/Yerevan'), 'YYYY-MM-DD') AS w
       FROM orders o WHERE o.customer_id = $1 AND o.placed_via_app AND o.created_at >= $2`,
    [customerId, since]
  );
  const { rows: share } = await db.query(
    `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE placed_via_app)::int AS via_app
       FROM orders WHERE customer_id = $1 AND status <> 'draft' AND created_at >= $2`,
    [customerId, new Date(now.getTime() - 90 * 86400000)]
  );
  const { rows: life } = await db.query("SELECT COUNT(*)::int AS n FROM orders WHERE customer_id = $1 AND placed_via_app", [customerId]);
  const weekStart = yerevanDateOf(week.startAt);
  return {
    ...levelProgress(m[0].n, settings.levels),
    levels: settings.levels,
    streak: streakWeeks(weeks.map((r) => r.w), weekStart),
    saved_this_month_amd: Math.round(m[0].app_discount + m[0].campaign_saved),
    app_orders_total: life[0].n,
    share_90d_pct: share[0].total ? Math.round((share[0].via_app / share[0].total) * 100) : null,
    month: yerevanToday(now).slice(0, 7),
  };
}
