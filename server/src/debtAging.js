// Invoice-based debt aging for the reports (Customer debt, Debt balances, Unpaid invoices).
// The same FIFO rule as debtAge.js: payments clear the oldest invoices first, so the debt is made
// of the newest orders (walk newest -> oldest until they add up to the debt; the rest is the
// opening balance of the paper era). Each unpaid piece ages by its own due date = order date +
// the customer's credit term, so the buckets count days PAST DUE, not days since the last payment.
import { ERP_OPENING_DATE, dueDays } from "./debtAge.js";

export const AGING_BUCKETS = ["not_due", "d1_30", "d31_60", "d61_90", "d90_plus", "opening"];
const AMOUNT_EPSILON = 1; // AMD

export function bucketOfDueDays(days) {
  if (days <= 0) return "not_due";
  if (days <= 30) return "d1_30";
  if (days <= 60) return "d31_60";
  if (days <= 90) return "d61_90";
  return "d90_plus";
}

// orders: [{ order_id, date: "YYYY-MM-DD", total }] newest first. debt <= 0 -> nothing unpaid.
export function allocateFifo({ orders, debt, today, termDays }) {
  const result = { invoices: [], opening: null, buckets: Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])), oldest_due_days: null, overdue_amd: 0 };
  let remaining = Number(debt) || 0;
  if (remaining <= AMOUNT_EPSILON) return result;
  for (const o of orders) {
    if (remaining <= AMOUNT_EPSILON) break;
    const total = Number(o.total) || 0;
    if (total <= 0) continue;
    const unpaid = Math.min(total, remaining);
    remaining -= unpaid;
    const days = dueDays(o.date, today, termDays);
    const bucket = bucketOfDueDays(days);
    result.invoices.push({ order_id: o.order_id, date: o.date, total, unpaid, due_days: days, bucket });
    result.buckets[bucket] += unpaid;
  }
  if (remaining > AMOUNT_EPSILON) {
    const days = dueDays(ERP_OPENING_DATE, today, termDays);
    result.opening = { unpaid: remaining, due_days: days, bucket: "opening" };
    result.buckets.opening += remaining;
  }
  const dueList = [...result.invoices.map((i) => i.due_days), ...(result.opening ? [result.opening.due_days] : [])];
  if (dueList.length) result.oldest_due_days = Math.max(...dueList);
  result.overdue_amd = Math.round(
    result.invoices.filter((i) => i.due_days > 0).reduce((s, i) => s + i.unpaid, 0) + (result.opening && result.opening.due_days > 0 ? result.opening.unpaid : 0)
  );
  return result;
}

// erpIds -> Map(erpId -> [{ order_id, date, total }]) newest first, optionally only orders up to asOf.
export async function loadOrdersNewestFirst(db, erpIds, { asOf = null } = {}) {
  const ids = [...new Set((erpIds ?? []).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;
  const params = [ids];
  let bound = "";
  if (asOf) {
    params.push(asOf);
    bound = "AND order_date <= $2::date";
  }
  const { rows } = await db.query(
    `SELECT erp_customer_id, order_id, to_char(order_date, 'YYYY-MM-DD') AS date, SUM(COALESCE(revenue_amd, 0)) AS total
     FROM erp_order_lines WHERE erp_customer_id = ANY($1) ${bound}
     GROUP BY erp_customer_id, order_id, order_date
     ORDER BY erp_customer_id, order_date DESC, order_id DESC`,
    params
  );
  for (const r of rows) {
    if (!map.has(r.erp_customer_id)) map.set(r.erp_customer_id, []);
    map.get(r.erp_customer_id).push({ order_id: r.order_id, date: r.date, total: Number(r.total) });
  }
  return map;
}
