// GET /api/ops/v1/kpi?period=week|month[&mode=complete|to_date]: the business numbers for the Monday brief and the analyst agents.
// The flows (sales, liters, gross profit, orders, active customers, collections) come from the Excel (ERP order lines and cashflow: the
// trusted source) for three windows: the current period, the previous one and the same period a year ago. The snapshots (receivables with
// aging and top debtors, stock value) are as of now: the live debt the app shows everywhere (money/liveDebt.js) and the synced stock.
// Same SQL rules as Operations control (opsReports.js priceRealization) and Ask KAD (team/askKad/tools.js): customer 10000 is not a sale,
// liters = qty x pack size, gross profit at the CURRENT landing cost of the product (lines of products without one are left out of the
// profit and reported as cost_coverage_pct).
// PRIVACY (owner, 2026-11-07): customers appear only as their ERP customer ID; amounts are whole AMD; no names, phones, TINs or staff.
import { pool } from "../../db/pool.js";
import { liveDebtors } from "../../money/liveDebt.js";
import { AGING_BUCKETS } from "../../money/debtAging.js";
import { yerevanToday } from "../../utils/yerevanDate.js";

export const KPI_PERIODS = ["week", "month"];
export const KPI_MODES = ["complete", "to_date"];
const TOP_DEBTORS = 10;
const SIZE = (col) =>
  `(CASE WHEN regexp_replace(trim(${col}), '[Ll]$', '') ~ '^[0-9]+(\\.[0-9]+)?$' THEN regexp_replace(trim(${col}), '[Ll]$', '')::numeric ELSE 0 END)`;

const iso = (d) => d.toISOString().slice(0, 10);
const dayOf = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => iso(new Date(dayOf(s).getTime() + n * 86400000));
const monthStart = (y, m) => iso(new Date(Date.UTC(y, m, 1))); // m may be out of 0..11: Date.UTC rolls it over
const monthEnd = (y, m) => iso(new Date(Date.UTC(y, m + 1, 0)));
const amd = (v) => Math.round(Number(v) || 0);

/**
 * The three windows of a period (dates inclusive, Yerevan calendar).
 *   week  complete: last Monday-Sunday week; to_date: this Monday .. today. Last year = the same weekdays 52 weeks (364 days) earlier.
 *   month complete: last calendar month; to_date: the 1st .. today. Previous / last year: the same day numbers, cut at the month's end.
 */
export function kpiWindows(period, mode, today) {
  if (period === "week") {
    const monday = addDays(today, -((dayOf(today).getUTCDay() + 6) % 7));
    const current = mode === "to_date" ? { from: monday, to: today } : { from: addDays(monday, -7), to: addDays(monday, -1) };
    const shift = (w, n) => ({ from: addDays(w.from, n), to: addDays(w.to, n) });
    return { current, previous: shift(current, -7), last_year: shift(current, -364) };
  }
  const t = dayOf(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  if (mode === "to_date") {
    const d = t.getUTCDate();
    const upTo = (yy, mm) => {
      const from = monthStart(yy, mm);
      const end = monthEnd(yy, mm);
      const want = `${from.slice(0, 8)}${String(d).padStart(2, "0")}`;
      return { from, to: want < end ? want : end };
    };
    return { current: { from: monthStart(y, m), to: today }, previous: upTo(y, m - 1), last_year: upTo(y - 1, m) };
  }
  const whole = (yy, mm) => ({ from: monthStart(yy, mm), to: monthEnd(yy, mm) });
  return { current: whole(y, m - 1), previous: whole(y, m - 2), last_year: whole(y - 1, m - 1) };
}

const pct = (a, b) => (b ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null);
const FLOW_KEYS = ["sales_amd", "liters", "gross_profit_amd", "orders", "active_customers", "collections_amd"];

export async function kpi(db = pool, { period = "week", mode = "complete", today = yerevanToday() } = {}) {
  const windows = kpiWindows(period, mode, today);
  const names = Object.keys(windows);
  const params = names.flatMap((k) => [windows[k].from, windows[k].to]);
  const inWin = (col, i) => `${col} BETWEEN $${i * 2 + 1}::date AND $${i * 2 + 2}::date`;
  // only the three windows' days (not the 13 months from last year's window to today)
  const anyWin = (col) => `(${names.map((_, i) => inWin(col, i)).join(" OR ")})`;
  const [sales, cash, through, debtors, stock] = await Promise.all([
    db.query(
      `WITH l AS (
         SELECT eol.order_date AS d, eol.erp_customer_id AS cust, eol.order_id, COALESCE(eol.revenue_amd, 0) AS rev,
                COALESCE(eol.qty, 0) * ${SIZE("eol.size_l")} AS liters,
                CASE WHEN p.landing_cost_amd > 0 THEN COALESCE(eol.qty, 0) * p.landing_cost_amd END AS cost
           FROM erp_order_lines eol LEFT JOIN products p ON lower(p.erp_product_id) = lower(eol.product_id)
          WHERE ${anyWin("eol.order_date")} AND eol.erp_customer_id <> '10000')
       SELECT ${names
         .map(
           (k, i) => `COALESCE(sum(rev) FILTER (WHERE ${inWin("d", i)}), 0)::float8 AS ${k}_rev,
              COALESCE(sum(liters) FILTER (WHERE ${inWin("d", i)}), 0)::float8 AS ${k}_liters,
              COALESCE(sum(cost) FILTER (WHERE ${inWin("d", i)}), 0)::float8 AS ${k}_cost,
              COALESCE(sum(rev) FILTER (WHERE ${inWin("d", i)} AND cost IS NOT NULL), 0)::float8 AS ${k}_rev_costed,
              count(DISTINCT cust || ':' || order_id) FILTER (WHERE ${inWin("d", i)})::int AS ${k}_orders,
              count(DISTINCT cust) FILTER (WHERE ${inWin("d", i)} AND rev > 0)::int AS ${k}_customers`
         )
         .join(",\n")}
       FROM l`,
      params
    ),
    db.query(
      `SELECT ${names.map((k, i) => `COALESCE(sum(amount_amd) FILTER (WHERE ${inWin("cashflow_date", i)}), 0)::float8 AS ${k}`).join(", ")}
         FROM erp_cashflow_lines WHERE amount_amd > 0 AND erp_customer_id <> '10000' AND ${anyWin("cashflow_date")}`,
      params
    ),
    db.query(
      `SELECT to_char((SELECT max(order_date) FROM erp_order_lines), 'YYYY-MM-DD') AS sales,
              to_char((SELECT max(cashflow_date) FROM erp_cashflow_lines), 'YYYY-MM-DD') AS collections`
    ),
    liveDebtors(db, { today }),
    db.query(
      `SELECT COALESCE(sum(stock_qty * landing_cost_amd) FILTER (WHERE landing_cost_amd > 0), 0)::float8 AS value,
              count(*)::int AS products, count(*) FILTER (WHERE NOT COALESCE(landing_cost_amd > 0, false))::int AS without_cost,
              max(synced_at) AS synced_at
         FROM products WHERE active AND stock_qty > 0`
    ),
  ]);
  const s = sales.rows[0];
  const flows = Object.fromEntries(
    names.map((k) => {
      const rev = s[`${k}_rev`];
      const costed = s[`${k}_rev_costed`];
      const gp = costed - s[`${k}_cost`];
      return [
        k,
        {
          from: windows[k].from,
          to: windows[k].to,
          sales_amd: amd(rev),
          liters: Math.round(s[`${k}_liters`]),
          gross_profit_amd: amd(gp),
          gross_margin_pct: costed > 0 ? Math.round((gp / costed) * 1000) / 10 : null,
          cost_coverage_pct: rev > 0 ? Math.round((costed / rev) * 1000) / 10 : null,
          orders: s[`${k}_orders`],
          active_customers: s[`${k}_customers`],
          collections_amd: amd(cash.rows[0][k]),
        },
      ];
    })
  );
  const change = (other) => Object.fromEntries(FLOW_KEYS.map((f) => [f, pct(flows.current[f], flows[other][f])]));

  const buckets = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0]));
  for (const r of debtors) for (const [b, v] of Object.entries(r.live.aging.buckets)) buckets[b] = (buckets[b] ?? 0) + v;
  const st = stock.rows[0];
  return {
    period,
    mode,
    currency: "AMD",
    generated_at: new Date().toISOString(),
    today,
    data_through: through.rows[0],
    flows,
    change_pct: { vs_previous: change("previous"), vs_last_year: change("last_year") },
    receivables: {
      as_of: today,
      total_amd: amd(debtors.reduce((t, r) => t + r.live.debt_amd, 0)),
      overdue_amd: amd(debtors.reduce((t, r) => t + r.live.aging.overdue_amd, 0)),
      customers: debtors.length,
      aging_buckets_amd: Object.fromEntries(Object.entries(buckets).map(([b, v]) => [b, amd(v)])),
      top_debtors: debtors.slice(0, TOP_DEBTORS).map((r) => ({
        customer_erp_id: r.erp_customer_id,
        debt_amd: amd(r.live.debt_amd),
        overdue_amd: amd(r.live.aging.overdue_amd),
        oldest_due_days: r.live.aging.oldest_due_days ?? null,
      })),
    },
    stock: {
      as_of: st.synced_at ? new Date(st.synced_at).toISOString() : null,
      value_landing_amd: amd(st.value),
      products_in_stock: st.products,
      products_without_landing_cost: st.without_cost,
    },
  };
}
