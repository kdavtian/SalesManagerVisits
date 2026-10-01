// Warehouse Inventory "days of stock left" estimate. Pure functions only --
// no DB access here, so the model itself can be unit-tested against fixed
// inputs without a database. The caller (routes/warehouse.js) supplies two
// real sales windows pulled from erp_order_lines (the actual ERP sales
// history, not just in-app draft orders -- see docs/erp-sync-contract.md)
// plus the product's current stock_qty, created_at and last sale date.
//
// --- The model ---------------------------------------------------------
// A plain trailing average (e.g. "total sold / 90 days") reacts to a trend
// only after it's fully baked into a long window, which is exactly the lag
// a reorder decision can't afford. Instead this blends two windows:
//   - a 30-day window, which reacts fast to a real recent shift in demand
//   - a 90-day window, which damps out a single unusually big or small week
// Blended at 60/40 (recent/baseline): when the 30-day rate is running
// above the 90-day rate, the blend rises above the plain 90-day average
// (demand is accelerating); when it's running below, the blend falls
// (demand is decelerating). That *is* "tendency of demand" in a model with
// no hidden curve-fitting -- every number in it is auditable from the raw
// windows.
const RECENT_WINDOW_DAYS = 30;
const BASELINE_WINDOW_DAYS = 90;
const RECENT_WEIGHT = 0.6;
const BASELINE_WEIGHT = 0.4;

// A swing smaller than this between the two windows' own daily rates is
// within normal week-to-week noise for a trailing sales count -- not
// flagged as a real trend either direction.
const TREND_RATIO_UP = 1.15;
const TREND_RATIO_DOWN = 0.85;

// No sale at all in the last 180 days, with stock still sitting on the
// shelf: textbook dead stock regardless of how much is left. A product
// younger than NEW_PRODUCT_GRACE_DAYS with zero sales isn't judged yet --
// there's been no real window to sell it in.
export const DEAD_STOCK_DAYS = 180;
const NEW_PRODUCT_GRACE_DAYS = 60;

// Reorder-urgency thresholds. A WM needs the shelf to last through however
// long a reorder actually takes to land -- order lead time plus a safety
// margin for the unexpected. Without a per-product lead time on record,
// 21 days (3 weeks: a typical 1-2 week supplier lead time plus a buffer)
// is the "start paying attention" line, and under a week left is
// "critical" regardless of lead time, since almost nothing reorders that
// fast.
export const CRITICAL_DAYS_THRESHOLD = 7;
export const LOW_DAYS_THRESHOLD = 21;

// Date.UTC takes a zero-indexed month (0 = January), but a "YYYY-MM-DD"
// string's own MM is one-indexed -- parsed straight through, this quietly
// read every date one month in the future, so e.g. a sale from 181 days
// ago could come out looking 150 days ago instead, well inside
// DEAD_STOCK_DAYS. Caught by stockForecast.test.js's dead-stock boundary
// case.
function parseIsoDateUTC(dateStr) {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function daysBetween(fromDateStr, toDateStr) {
  return Math.round((parseIsoDateUTC(toDateStr) - parseIsoDateUTC(fromDateStr)) / 86400000);
}

function toDateString(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

// { stockQty, qty30d, qty90d, lastSaleDate, createdAt, today } -> a stock
// forecast for one product (one row in `products` -- a specific size is
// its own row, so this is naturally per-size, not blended across sizes of
// the same product name).
//
// Returns { status, dailyDemand, daysOfStock, trend }:
//   status: 'unknown' | 'out' | 'new' | 'dead' | 'slow' | 'critical' | 'low' | 'ok'
//   dailyDemand: estimated units/day, or null when there's nothing to base one on
//   daysOfStock: stockQty / dailyDemand, or null when it can't be estimated
//   trend: 'up' | 'down' | 'flat' | null (null wherever dailyDemand is null)
export function computeStockForecast({ stockQty, qty30d, qty90d, lastSaleDate, createdAt, today }) {
  if (stockQty == null) return { status: "unknown", dailyDemand: null, daysOfStock: null, trend: null };
  if (stockQty <= 0) return { status: "out", dailyDemand: null, daysOfStock: 0, trend: null };

  const todayStr = toDateString(today);
  const lastSaleStr = toDateString(lastSaleDate);
  const createdStr = toDateString(createdAt);

  if (!lastSaleStr) {
    const daysSinceCreated = createdStr ? daysBetween(createdStr, todayStr) : Infinity;
    if (daysSinceCreated > NEW_PRODUCT_GRACE_DAYS) {
      return { status: "dead", dailyDemand: 0, daysOfStock: null, trend: null };
    }
    return { status: "new", dailyDemand: null, daysOfStock: null, trend: null };
  }

  const daysSinceSale = daysBetween(lastSaleStr, todayStr);
  if (daysSinceSale > DEAD_STOCK_DAYS) {
    return { status: "dead", dailyDemand: 0, daysOfStock: null, trend: null };
  }

  const recentRate = (Number(qty30d) || 0) / RECENT_WINDOW_DAYS;
  const baselineRate = (Number(qty90d) || 0) / BASELINE_WINDOW_DAYS;
  const dailyDemand = RECENT_WEIGHT * recentRate + BASELINE_WEIGHT * baselineRate;

  if (dailyDemand <= 0) {
    // Had a sale somewhere in the last 180 days, but nothing in the last
    // 90 -- still moving, just too slowly to put a meaningful days-left
    // number on (dividing by a near-zero rate produces a meaninglessly
    // huge number, not a precise one).
    return { status: "slow", dailyDemand: 0, daysOfStock: null, trend: null };
  }

  let trend = "flat";
  if (baselineRate > 0) {
    if (recentRate >= baselineRate * TREND_RATIO_UP) trend = "up";
    else if (recentRate <= baselineRate * TREND_RATIO_DOWN) trend = "down";
  } else if (recentRate > 0) {
    trend = "up";
  }

  const daysOfStock = stockQty / dailyDemand;
  let status;
  if (daysOfStock < CRITICAL_DAYS_THRESHOLD) status = "critical";
  else if (daysOfStock < LOW_DAYS_THRESHOLD) status = "low";
  else status = "ok";

  return { status, dailyDemand, daysOfStock, trend };
}
