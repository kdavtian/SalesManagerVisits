// The numbers on the desktop Home (owner, 2026-10-25: "desktop Home = a KPI dashboard instead of duplicating the menu"): sales of the month next to the
// same days of last month, what customers owe and how much of it is late, payments recorded in the app that the Excel does not show, what is waiting
// in the order flow, and open tasks. Every figure is a decision for a person (see the KADDev "data -> decision -> action" rule): each tile opens the page
// where it is dealt with. One request, cached for a minute, so opening Home stays quick.
import { pool } from "./db/pool.js";
import { allocateFifo, loadOrdersNewestFirst } from "./debtAging.js";
import { yerevanToday } from "./utils/yerevanDate.js";
import { IN_EXCEL_SQL, DAYS_OLD_SQL, EXCEL_GRACE_DAYS } from "./paymentExcelMatch.js";
import { rolesWhere, seesHomeKpis } from "./roles.js";

export const KPI_ROLES = rolesWhere(seesHomeKpis);

const num = (v) => Number(v) || 0;
let cache = { at: 0, data: null };

async function salesFigures(today) {
  const [y, m, d] = today.split("-").map(Number);
  const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const prevStart = prev.toISOString().slice(0, 10);
  // the same number of days of last month (a month that is shorter just ends at its own last day)
  const prevDays = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)).getUTCDate();
  const prevEnd = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth(), Math.min(d, prevDays))).toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(revenue_amd) FILTER (WHERE order_date >= $1 AND order_date <= $2), 0) AS mtd,
            COALESCE(SUM(revenue_amd) FILTER (WHERE order_date >= $3 AND order_date <= $4), 0) AS prev_mtd,
            COALESCE(SUM(revenue_amd) FILTER (WHERE order_date >= $3 AND order_date < $1), 0) AS prev_month
       FROM erp_order_lines WHERE erp_customer_id <> '10000' AND order_date >= $3`,
    [monthStart, today, prevStart, prevEnd]
  );
  return { mtd_amd: Math.round(num(rows[0].mtd)), prev_mtd_amd: Math.round(num(rows[0].prev_mtd)), prev_month_amd: Math.round(num(rows[0].prev_month)), day: d, days_in_month: new Date(Date.UTC(y, m, 0)).getUTCDate() };
}

async function debtFigures(today) {
  const { rows } = await pool.query(
    `SELECT c.erp_customer_id AS customer_id, ecd.debt_amd, c.credit_term_days
       FROM erp_customer_data ecd JOIN customers c ON c.erp_customer_id = ecd.erp_customer_id
      WHERE ecd.debt_amd > 0`
  );
  const orders = await loadOrdersNewestFirst(pool, rows.map((r) => r.customer_id), {});
  let total = 0;
  let overdue = 0;
  let overdueCustomers = 0;
  for (const r of rows) {
    const debt = num(r.debt_amd);
    total += debt;
    const a = allocateFifo({ orders: orders.get(r.customer_id) ?? [], debt, today, termDays: r.credit_term_days ?? 45 });
    if (a.overdue_amd > 0) {
      overdue += a.overdue_amd;
      overdueCustomers += 1;
    }
  }
  return { total_amd: Math.round(total), customers: rows.length, overdue_amd: Math.round(overdue), overdue_customers: overdueCustomers };
}

export async function computeKpis(now = new Date()) {
  const today = yerevanToday(now);
  const [sales, debt, notInExcel, pending, orders, tasks] = await Promise.all([
    salesFigures(today),
    debtFigures(today),
    pool.query(
      `SELECT count(*)::int AS n, COALESCE(sum(p.amount_amd), 0) AS amd
         FROM payments p
        WHERE p.status IN ('pending', 'approved') AND p.erp_customer_id_snapshot IS NOT NULL
          AND ${DAYS_OLD_SQL} >= ${EXCEL_GRACE_DAYS} AND NOT ${IN_EXCEL_SQL} AND p.payment_date > now() - interval '120 days'`
    ),
    pool.query("SELECT count(*)::int AS n FROM payments WHERE status = 'pending'"),
    pool.query(
      `SELECT count(*) FILTER (WHERE status = 'submitted')::int AS to_confirm,
              count(*) FILTER (WHERE status = 'confirmed')::int AS to_pack,
              count(*) FILTER (WHERE status = 'packed_stock_out')::int AS to_deliver
         FROM orders`
    ),
    pool.query(
      `SELECT count(*)::int AS open, count(*) FILTER (WHERE due_date < $1::date)::int AS overdue FROM tasks WHERE status = 'open'`,
      [today]
    ),
  ]);
  return {
    as_of: today,
    sales,
    debt,
    payments: { not_in_excel_count: notInExcel.rows[0].n, not_in_excel_amd: Math.round(num(notInExcel.rows[0].amd)), pending_approval: pending.rows[0].n },
    orders: orders.rows[0],
    tasks: tasks.rows[0],
  };
}

// One minute is plenty for a Home screen; `force` is for tests.
export async function kpisCached({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < 60_000) return cache.data;
  const data = await computeKpis();
  cache = { at: Date.now(), data };
  return data;
}
