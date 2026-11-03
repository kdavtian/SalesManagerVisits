// "How many days of stock are left": the company's demand model (owner, 2026-11-03: "smart weighted order volume calculation, modern financial
// and operational techniques"). Pure functions, no database: the caller (routes/warehouse.js) supplies the product's weekly sales of the last
// 26 weeks (newest first, from the Excel order lines -- the trusted sales history), its stock, what open orders have already reserved, and
// today. The method is written for people in client/public/js/methodology.js ("Company Methodology" on the Products and Documents pages);
// change the two together.
//
//  1. Weekly buckets. Sales are counted per week, not per day: a day of nothing is normal for a lubricant, a week of nothing is information.
//  2. Outlier damping (winsorizing). One huge one-off order must not make the product look like a bestseller: a week is capped at
//     median + 3 x MAD (median absolute deviation, scaled), so a real change in level still moves the model (it moves the median) but a single
//     spike does not.
//  3. Exponential weighting. Recent weeks count more: a week's weight halves every 6 weeks (exponentially weighted moving average).
//  4. Intermittent demand. A product that sells in fewer than half of the weeks is not forecast with an average (it would swing between
//     "nothing" and "a lot"): Croston's method with the Syntetos-Boylan correction forecasts the size of a sale and the time between sales
//     separately.
//  5. Variability. The weighted standard deviation of the weekly sales gives a safety stock for the service level (default 95 %, z = 1.65) over the
//     supplier lead time (default 45 days; both are admin settings, demandSettings.js): SS = z x sigma_daily x sqrt(lead time). Reorder point = daily demand x lead time + SS.
//  6. Stock that is free to sell. Days left = (stock - reserved by open orders) / daily demand: stock already promised to a customer is not
//     stock the next customer can have.
//  7. Status from the reorder point, not from a fixed day count: critical = free stock is at or under the reorder point (order now),
//     low = it will reach it within the review period, ok = further away.

export const MODEL = Object.freeze({
  weeks: 26,
  halfLifeWeeks: 6,
  madCap: 3,
  leadTimeDays: 45, // from ordering to the goods being on the shelf (the same 45 days the old model used as "critical")
  reviewDays: 45, // how far ahead "low" looks beyond the lead time
  serviceZ: 1.65, // 95 % service level
  crostonAlpha: 0.25,
  intermittentShare: 0.5, // more than half of the weeks without a sale -> Croston
  minWindowWeeks: 13, // the shortest history a forecast is made from (a quarter)
  deadAfterDays: 180,
  newProductGraceDays: 60,
  trendUp: 1.15,
  trendDown: 0.85,
});

const DAY = 86400000;
const parseDay = (value) => {
  if (!value) return null;
  const [y, m, d] = String(value instanceof Date ? value.toISOString() : value).slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const daysBetween = (from, to) => Math.round((parseDay(to) - parseDay(from)) / DAY);

const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// weeklyQty: newest week first (index 0 = the 7 days ending today), up to MODEL.weeks numbers (a missing week counts as 0)
export function winsorize(weeklyQty) {
  const m = median(weeklyQty);
  if (!(m > 0)) return weeklyQty.slice(); // a mostly-empty series is lumpy by nature (Croston's case): its sales are not outliers
  // a perfectly flat series has no spread to measure: a quarter of the level stands in for it
  const mad = median(weeklyQty.map((x) => Math.abs(x - m))) * 1.4826 || 0.25 * m;
  const cap = m + MODEL.madCap * mad;
  return weeklyQty.map((x) => Math.min(x, cap));
}

// weights: 0.5 ^ (age in weeks / half-life), age 0 = the newest week
function weightedStats(series) {
  let sw = 0;
  let sx = 0;
  const w = series.map((_, i) => {
    const wi = Math.pow(0.5, i / MODEL.halfLifeWeeks);
    sw += wi;
    sx += wi * series[i];
    return wi;
  });
  const mean = sx / sw;
  const variance = series.reduce((acc, x, i) => acc + w[i] * (x - mean) ** 2, 0) / sw;
  return { mean, sd: Math.sqrt(variance) };
}

// Croston / Syntetos-Boylan: weekly demand = (smoothed size of a sale / smoothed weeks between sales) x (1 - alpha / 2)
function crostonWeekly(series) {
  const a = MODEL.crostonAlpha;
  let size = null;
  let interval = null;
  let since = 1;
  // oldest -> newest
  for (let i = series.length - 1; i >= 0; i--) {
    const x = series[i];
    if (x > 0) {
      size = size == null ? x : a * x + (1 - a) * size;
      interval = interval == null ? since : a * since + (1 - a) * interval;
      since = 1;
    } else {
      since += 1;
    }
  }
  if (size == null || !interval) return 0;
  return (size / interval) * (1 - a / 2);
}

/**
 * input: { weeklyQty: number[] newest first, stockQty, reservedQty = 0, lastSaleDate, createdAt, today, leadTimeDays, serviceZ }
 *   leadTimeDays / serviceZ: the admin's settings (demandSettings.js); without them the model's own 45 days and z = 1.65
 * Returns { status, dailyDemand, daysOfStock, trend, method, safetyStock, reorderPoint, freeStock, daysToReorder, variability }
 *   status: 'unknown' | 'out' | 'new' | 'dead' | 'slow' | 'critical' | 'low' | 'ok'  (the same words the old model used)
 */
export function computeDemandForecast({ weeklyQty = [], stockQty, reservedQty = 0, lastSaleDate = null, createdAt = null, today, leadTimeDays = MODEL.leadTimeDays, serviceZ = MODEL.serviceZ }) {
  const none = { dailyDemand: null, daysOfStock: null, trend: null, method: null, safetyStock: null, reorderPoint: null, freeStock: null, daysToReorder: null, variability: null };
  if (stockQty == null) return { status: "unknown", ...none };
  const stock = Number(stockQty);
  if (stock <= 0) return { status: "out", ...none, daysOfStock: 0, freeStock: 0 };

  const series = Array.from({ length: MODEL.weeks }, (_, i) => Math.max(0, Number(weeklyQty[i]) || 0));
  const anySale = series.some((x) => x > 0);
  if (!lastSaleDate && !anySale) {
    const age = createdAt ? daysBetween(createdAt, today) : Infinity;
    return age > MODEL.newProductGraceDays ? { status: "dead", ...none, dailyDemand: 0 } : { status: "new", ...none };
  }
  if (lastSaleDate && daysBetween(lastSaleDate, today) > MODEL.deadAfterDays) return { status: "dead", ...none, dailyDemand: 0 };
  if (!anySale) return { status: "slow", ...none, dailyDemand: 0 };

  // Only the weeks since the product started selling count (weeks before its first sale are not weeks of "no demand", the product was not
  // there), but never fewer than a quarter: one sale a few days ago must not read as steady daily demand.
  let oldestSale = series.length - 1;
  while (oldestSale > 0 && series[oldestSale] === 0) oldestSale -= 1;
  const window = Math.max(MODEL.minWindowWeeks, oldestSale + 1);
  const clean = winsorize(series.slice(0, window));
  const zeroShare = clean.filter((x) => x === 0).length / clean.length;
  const intermittent = zeroShare > MODEL.intermittentShare;
  const { mean, sd } = weightedStats(clean);
  const weekly = intermittent ? crostonWeekly(clean) : mean;
  const dailyDemand = weekly / 7;
  if (!(dailyDemand > 0)) return { status: "slow", ...none, dailyDemand: 0 };

  const sdDaily = sd / Math.sqrt(7);
  const safetyStock = Math.max(0, Math.ceil(serviceZ * sdDaily * Math.sqrt(leadTimeDays) - 1e-9));
  const reorderPoint = Math.ceil(dailyDemand * leadTimeDays + safetyStock - 1e-9);
  const freeStock = Math.max(0, stock - Math.max(0, Number(reservedQty) || 0));
  const daysOfStock = freeStock / dailyDemand;
  const daysToReorder = (freeStock - reorderPoint) / dailyDemand;

  // trend: the last 4 weeks against the 8 weeks before them (weights not needed: both are short, recent windows)
  const recent = clean.slice(0, 4).reduce((a, b) => a + b, 0) / 4;
  const before = clean.slice(4, 12).reduce((a, b) => a + b, 0) / 8;
  let trend = "flat";
  if (before > 0) {
    if (recent >= before * MODEL.trendUp) trend = "up";
    else if (recent <= before * MODEL.trendDown) trend = "down";
  } else if (recent > 0) trend = "up";

  const cv = weekly > 0 ? sd / weekly : 0;
  const variability = intermittent ? "Z" : cv < 0.5 ? "X" : cv < 1 ? "Y" : "Z"; // XYZ: steady, variable, erratic

  let status;
  if (freeStock <= reorderPoint) status = "critical";
  else if (freeStock <= dailyDemand * (leadTimeDays + MODEL.reviewDays) + safetyStock) status = "low";
  else status = "ok";

  return { status, dailyDemand, daysOfStock, trend, method: intermittent ? "croston" : "ewma", safetyStock, reorderPoint, freeStock, daysToReorder, variability };
}

// Weekly buckets (newest first) from [{ product_id, wk, qty }] rows, wk = whole weeks before today (0 = the last 7 days).
export function bucketWeeks(rows) {
  const byProduct = new Map();
  for (const r of rows) {
    const wk = Number(r.wk);
    if (!Number.isInteger(wk) || wk < 0 || wk >= MODEL.weeks) continue;
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, Array(MODEL.weeks).fill(0));
    byProduct.get(r.product_id)[wk] += Number(r.qty) || 0;
  }
  return byProduct;
}
