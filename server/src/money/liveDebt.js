// The live debt (payments redesign, release 3c, owner 2026-11-02: "everywhere, show the gap"): what the customer owes now =
//   the Excel debt + the app's delivered orders the Excel does not have yet - the app's payments the Excel does not have yet.
// The orders: the same rule the signed acts print as "previous debt" (orders/signedActs.js balanceBeforeVisit): an app order older than two
// weeks before the Excel's latest order and still unmatched is taken as already in the Excel. The payments: the Debt balances rule (below):
// an app payment of the last 60 days with no Excel cashflow line of the same amount within 5 days (one line per payment).
// A payment pays the customer's OLDEST unpaid orders first (owner's answer 3), Excel and app orders alike (debtAging.js allocateFifo walks
// the newest orders until they add up to the debt: the rest is paid). Paying more than the debt leaves an advance (answer 8).
import { allocateFifo, loadOrdersNewestFirst } from "./debtAging.js";
import { pool } from "../db/pool.js";
import { cashflowByCustomer } from "./cashflowCopy.js";
import { yerevanToday } from "../utils/yerevanDate.js";

const EXCEL_GRACE_DAYS = 14;
const day = (col) => `((${col} AT TIME ZONE 'Asia/Yerevan')::date)`;
const LIMITS_SQL = `lim AS (SELECT COALESCE((SELECT MAX(order_date) FROM erp_order_lines), (SELECT ${day("MAX(synced_at)")} FROM erp_customer_data)) - ${EXCEL_GRACE_DAYS} AS orders_from)`;

/**
 * The app rows the Excel does not hold yet, per customer (internal id):
 *   Map(customerId -> { orders: [{ order_id: 'app-<id>', app_order_id, code, date, total }] newest first, orders_amd, payments_amd, payments_count })
 */
export async function liveAdjustments(db, customerIds) {
  const ids = [...new Set((customerIds ?? []).map(Number).filter(Number.isInteger))];
  const result = new Map();
  if (!ids.length) return result;
  const entry = (id) => {
    if (!result.has(id)) result.set(id, { orders: [], orders_amd: 0, payments_amd: 0, payments_count: 0 });
    return result.get(id);
  };
  const [{ rows: orders }, { rows: customers }] = await Promise.all([
    db.query(
      `WITH ${LIMITS_SQL},
            o AS (SELECT o.customer_id, o.id, o.order_code, o.total_amd,
                         ${day("COALESCE((SELECT MAX(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = 'delivered'), o.updated_at)")} AS delivered_day
                  FROM orders o WHERE o.customer_id = ANY($1) AND o.status = 'delivered' AND o.erp_matched_order_id IS NULL)
       SELECT o.customer_id, o.id, o.order_code, o.total_amd::float8 AS total, to_char(o.delivered_day, 'YYYY-MM-DD') AS date
       FROM o, lim WHERE o.delivered_day >= COALESCE(lim.orders_from, DATE '1900-01-01')
       ORDER BY o.customer_id, o.delivered_day DESC, o.id DESC`,
      [ids]
    ),
    db.query("SELECT id AS internal_customer_id, erp_customer_id AS customer_id FROM customers WHERE id = ANY($1)", [ids]),
  ]);
  // the payments: matched against the Excel cashflow one by one (loadUnrecordedPayments below), every rep's (the debt is the customer's)
  const payments = await loadUnrecordedPayments(customers, null, db);
  for (const o of orders) {
    const e = entry(o.customer_id);
    e.orders.push({ order_id: `app-${o.id}`, app_order_id: o.id, code: o.order_code, date: o.date, total: Math.round(o.total) });
    e.orders_amd += Math.round(o.total);
  }
  for (const [customerId, p] of payments) {
    const e = entry(customerId);
    e.payments_amd = Math.round(p.amount);
    e.payments_count = p.count;
  }
  // Release 4 (owner, 2026-11-02): bank / card payments (Bank & cash desks: typed by the accountant or read from a statement) lower the
  // live debt too, until the Excel's books have them (books_state open). They live only in customer_payments (no old-module row), so they
  // are never counted twice with the cash payments above.
  const { rows: bank } = await db.query(
    `SELECT customer_id, COALESCE(SUM(amount_amd), 0)::float8 AS amd, count(*)::int AS n FROM customer_payments
     WHERE customer_id = ANY($1) AND legacy_payment_id IS NULL AND voided_at IS NULL AND method IN ('bank', 'card') AND books_state = 'open'
       AND pay_day >= (now() AT TIME ZONE 'Asia/Yerevan')::date - 60
     GROUP BY customer_id`,
    [ids]
  );
  for (const b of bank) {
    const e = entry(b.customer_id);
    e.payments_amd += Math.round(b.amd);
    e.payments_count += b.n;
    e.bank_payments_amd = Math.round(b.amd);
  }
  return result;
}

/** Map(customerId -> live numbers) for many customers at once (live view): what the debt-reading screens and jobs need. */
export async function liveDebtMap(db, rows, today) {
  // rows: [{ id, erp_customer_id, debt_amd (Excel), credit_term_days }]
  const withErp = rows.filter((r) => r.erp_customer_id && r.debt_amd != null);
  const [adj, orders] = await Promise.all([liveAdjustments(db, withErp.map((r) => r.id)), loadOrdersNewestFirst(db, withErp.map((r) => r.erp_customer_id))]);
  const out = new Map();
  for (const r of withErp) {
    out.set(r.id, liveDebtOf({ excelDebt: r.debt_amd, excelOrders: orders.get(r.erp_customer_id) ?? [], adj: adj.get(r.id), today, termDays: r.credit_term_days ?? 45 }));
  }
  return out;
}

/**
 * One customer's live debt and which orders it is made of.
 *   excelDebt: the Excel debt (null = no Excel figure: nothing to compute); excelOrders: [{ order_id, date, total }] newest first;
 *   adj: one liveAdjustments entry (or undefined).
 * Returns { debt_amd, excel_amd, orders_not_in_excel_amd, payments_not_in_excel_amd, advance_amd, aging } (aging = allocateFifo's result).
 */
export function liveDebtOf({ excelDebt, excelOrders = [], adj, today, termDays = 45 }) {
  if (excelDebt == null) return null;
  const excel = Math.round(Number(excelDebt) || 0);
  const ordersAmd = adj?.orders_amd ?? 0;
  const paymentsAmd = adj?.payments_amd ?? 0;
  const live = excel + ordersAmd - paymentsAmd;
  // newest first across both lists (the app orders are the newest: the Excel has not caught up with them)
  const all = [...(adj?.orders ?? []), ...excelOrders].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const aging = allocateFifo({ orders: all, debt: live, today, termDays });
  return {
    debt_amd: Math.max(0, live),
    excel_amd: excel,
    orders_not_in_excel_amd: ordersAmd,
    payments_not_in_excel_amd: paymentsAmd,
    advance_amd: live < 0 ? -live : 0,
    aging,
  };
}

/** The debt chip / overdue fields of the customer card from a live result (the same shape as debtAge.js summarizeDebt). */
export function liveSummary(live) {
  const a = live.aging;
  return {
    unpaid_orders: a.invoices.length,
    oldest_due_days: a.oldest_due_days,
    overdue_amd: a.overdue_amd,
    opening_unpaid_amd: a.opening?.unpaid ?? 0,
    opening_due_days: a.opening?.due_days ?? null,
  };
}

// App payments (pending or approved, not rejected) of the last 60 days that the Excel cashflow does not show yet: the
// accountant has not entered them. Matched the same way the customer card's "Payments received" sheet does it: same
// amount, within 5 days, one ERP line per payment. A payment the ERP sync already settled ("From ERP") is recorded.
// A sales manager only counts their own collections.
const UNRECORDED_DAYS = 60;
const MATCH_DAYS = 5;
export async function loadUnrecordedPayments(rows, user, db = pool) {
  const result = new Map();
  const internalIds = rows.map((r) => r.internal_customer_id);
  const erpIds = rows.map((r) => r.customer_id).filter(Boolean);
  if (!internalIds.length) return result;
  const params = [internalIds, UNRECORDED_DAYS];
  let scope = "";
  if (user?.role === "sales_manager") {
    params.push(user.id);
    scope = `AND p.sales_manager_id = $${params.length}`;
  }
  const { rows: appRows } = await db.query(
    `SELECT p.id, p.customer_id, p.amount_amd,
            to_char(p.payment_date AT TIME ZONE 'Asia/Yerevan', 'YYYY-MM-DD') AS date
       FROM payments p
      WHERE p.customer_id = ANY($1) AND p.status IN ('pending', 'approved') AND NOT COALESCE(p.approved_from_erp, false)
        AND p.payment_date >= now() - ($2 || ' days')::interval ${scope}
      ORDER BY p.payment_date, p.id`,
    params
  );
  if (!appRows.length) return result;
  // the Excel payments of the same weeks: from the server's copy of the cashflow lines (cashflowCopy.js), else from the table
  const copy = await cashflowByCustomer(db);
  const since = new Date(Date.parse(`${yerevanToday()}T00:00:00Z`) - (UNRECORDED_DAYS + MATCH_DAYS) * 86400000).toISOString().slice(0, 10);
  const erpRows = copy
    ? erpIds.flatMap((id) => (copy.get(id) ?? []).filter((l) => l.amount > 0 && l.date >= since).map((l) => ({ erp_customer_id: id, amount_amd: l.amount, date: l.date })))
    : (
        await db.query(
          `SELECT erp_customer_id, amount_amd, to_char(cashflow_date, 'YYYY-MM-DD') AS date
             FROM erp_cashflow_lines
            WHERE erp_customer_id = ANY($1) AND amount_amd > 0 AND cashflow_date >= (now() AT TIME ZONE 'Asia/Yerevan')::date - ($2::int + $3::int)`,
          [erpIds, UNRECORDED_DAYS, MATCH_DAYS]
        )
      ).rows;
  const erpByCustomer = new Map();
  for (const l of erpRows) {
    if (!erpByCustomer.has(l.erp_customer_id)) erpByCustomer.set(l.erp_customer_id, []);
    erpByCustomer.get(l.erp_customer_id).push({ ts: new Date(l.date).getTime(), amount: Number(l.amount_amd), used: false });
  }
  const erpIdOf = new Map(rows.map((r) => [r.internal_customer_id, r.customer_id]));
  const DAY = 24 * 3600 * 1000;
  for (const p of appRows) {
    const lines = erpByCustomer.get(erpIdOf.get(p.customer_id)) ?? [];
    const ts = new Date(p.date).getTime();
    const hit = lines.find((l) => !l.used && l.amount === Number(p.amount_amd) && Math.abs(l.ts - ts) <= MATCH_DAYS * DAY);
    if (hit) {
      hit.used = true;
      continue;
    }
    const cur = result.get(p.customer_id) ?? { amount: 0, count: 0 };
    cur.amount += Number(p.amount_amd);
    cur.count += 1;
    result.set(p.customer_id, cur);
  }
  return result;
}

