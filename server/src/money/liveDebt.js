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
import { netDebt, frozenApplied } from "../shared/netDebt.js";

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
                         ${day("COALESCE((SELECT MAX(h.changed_at) FROM order_status_history h WHERE h.order_id = o.id AND h.new_status = 'delivered' AND h.old_status IS DISTINCT FROM 'recorded'), o.updated_at)")} AS delivered_day
                  FROM orders o WHERE o.customer_id = ANY($1) AND o.status IN ('delivered', 'recorded') AND o.erp_matched_order_id IS NULL)
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
    e.payment_items = p.items;
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

/**
 * One customer's live debt as a single number, for the papers (owner, 2026-11-03: the debt statement, the order blank's and the signed
 * act's "previous debt" and the payment slip use the live debt, so what the customer signs matches what the app shows). The orders and the
 * payment of the visit being written are left out (the paper writes them as this visit's own amounts):
 *   excludeOrderIds  app order ids   excludePaymentIds  app payment ids   checkinId  the visit (its payment carries client_ref checkin-<id>)
 * null when the customer has no Excel debt figure (the paper leaves the line blank). Negative = an advance.
 */
export async function liveBalance(db, customerId, options = {}) {
  return (await liveBalances(db, [{ customerId, ...options }]))[0];
}

// The same for many customers in one go (a print of 40 blanks makes one set of queries, not 40): requests = [{ customerId, excludeOrderIds,
// excludePaymentIds, checkinId }]; returns the amounts in the same order.
export async function liveBalances(db, requests) {
  const ids = [...new Set(requests.map((r) => Number(r.customerId)))];
  if (!ids.length) return [];
  const [{ rows }, adjAll] = await Promise.all([
    db.query("SELECT c.id, erp.debt_amd::float8 AS debt FROM customers c LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id WHERE c.id = ANY($1)", [ids]),
    liveAdjustments(db, ids),
  ]);
  const excel = new Map(rows.map((r) => [r.id, r.debt]));
  return requests.map(({ customerId, excludeOrderIds = [], excludePaymentIds = [], checkinId = null }) => {
    const debt = excel.get(Number(customerId));
    if (debt == null) return null;
    const adj = adjAll.get(Number(customerId));
    const skipOrders = new Set(excludeOrderIds.map(Number));
    const skipPayments = new Set(excludePaymentIds.filter(Boolean).map(Number));
    const ref = checkinId ? `checkin-${checkinId}` : null;
    const orders = (adj?.orders ?? []).filter((o) => !skipOrders.has(o.app_order_id)).reduce((sum, o) => sum + o.total, 0);
    const cash = (adj?.payment_items ?? []).filter((p) => !skipPayments.has(p.id) && !(ref && p.client_ref === ref)).reduce((sum, p) => sum + p.amount, 0);
    return Math.round(debt + orders - cash - (adj?.bank_payments_amd ?? 0));
  });
}

/** Map(customerId -> frozen credit amount) for the customers that have one (customers.frozen_credit_amd, migration 182). */
export async function frozenOf(db, customerIds) {
  if (!customerIds.length) return new Map();
  const { rows } = await db.query("SELECT id, frozen_credit_amd::float8 AS frozen FROM customers WHERE id = ANY($1) AND frozen_credit_amd > 0", [customerIds]);
  return new Map(rows.map((r) => [r.id, r.frozen]));
}

/** Map(customerId -> live numbers) for many customers at once (live view): what the debt-reading screens and jobs need. */
export async function liveDebtMap(db, rows, today, { gross = false } = {}) {
  // rows: [{ id, erp_customer_id, debt_amd (Excel), credit_term_days }]
  // debt_amd of the answer is the NET debt (live - frozen credit, owner 2026-11-03) unless gross is asked for (a paper the customer signs).
  const withErp = rows.filter((r) => r.erp_customer_id && r.debt_amd != null);
  const [adj, frozen] = await Promise.all([liveAdjustments(db, withErp.map((r) => r.id)), gross ? new Map() : frozenOf(db, withErp.map((r) => r.id))]);
  // the Excel orders only for the customers who owe something live (a customer at zero or in advance has no unpaid order to age)
  const liveOf = (r) => Math.round(Number(r.debt_amd) || 0) + (adj.get(r.id)?.orders_amd ?? 0) - (adj.get(r.id)?.payments_amd ?? 0);
  const owing = withErp.filter((r) => liveOf(r) > 0);
  const orders = await loadOrdersNewestFirst(db, owing.map((r) => r.erp_customer_id));
  const out = new Map();
  for (const r of withErp) {
    out.set(r.id, liveDebtOf({ excelDebt: r.debt_amd, excelOrders: orders.get(r.erp_customer_id) ?? [], adj: adj.get(r.id), today, termDays: r.credit_term_days ?? 45, frozenAmd: frozen.get(r.id) ?? 0 }));
  }
  return out;
}

// A customer who may owe money on the live debt: the Excel says so, or a delivered app order the Excel does not have yet
// (the exact window is applied by liveAdjustments; this only narrows the list cheaply). Aliases: c = customers, erp = erp_customer_data.
export const LIVE_DEBT_CANDIDATE_SQL = `(COALESCE(erp.debt_amd, 0) > 0 OR EXISTS (
  SELECT 1 FROM orders lo WHERE lo.customer_id = c.id AND lo.status IN ('delivered', 'recorded') AND lo.erp_matched_order_id IS NULL))`;

/**
 * Every customer who owes money on the LIVE debt (release 5, owner 2026-11-03: reports, the weekly debt digest and Vaghinak's
 * debt tasks on the live debt too), biggest first. One query over customers c JOIN erp_customer_data erp, plus the caller's
 *   select  extra columns ("c.name AS name, ...")   join  extra joins   where  extra AND conditions   params  their values ($1..)
 * Each row comes back with `live` (liveDebtOf's result: debt_amd, excel_amd, orders_not_in_excel_amd, payments_not_in_excel_amd,
 * advance_amd, aging). A customer only in advance or at zero is left out.
 */
export async function liveDebtors(db, { select = "", join = "", where = "", params = [], today }) {
  const { rows } = await db.query(
    `SELECT c.id, c.erp_customer_id, COALESCE(c.credit_term_days, 45) AS credit_term_days, COALESCE(erp.debt_amd, 0)::float8 AS debt_amd${select ? `, ${select}` : ""}
     FROM customers c JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id ${join}
     WHERE ${LIVE_DEBT_CANDIDATE_SQL} ${where ? `AND ${where}` : ""}`,
    params
  );
  const live = await liveDebtMap(db, rows, today);
  return rows
    .map((r) => ({ ...r, live: live.get(r.id) }))
    .filter((r) => r.live && r.live.debt_amd > 0)
    .sort((a, b) => b.live.debt_amd - a.live.debt_amd);
}

/**
 * One customer's live debt and which orders it is made of.
 *   excelDebt: the Excel debt (null = no Excel figure: nothing to compute); excelOrders: [{ order_id, date, total }] newest first;
 *   adj: one liveAdjustments entry (or undefined).
 * Returns { debt_amd, excel_amd, orders_not_in_excel_amd, payments_not_in_excel_amd, advance_amd, aging } (aging = allocateFifo's result).
 */
export function liveDebtOf({ excelDebt, excelOrders = [], adj, today, termDays = 45, frozenAmd = 0 }) {
  if (excelDebt == null) return null;
  const excel = Math.round(Number(excelDebt) || 0);
  const ordersAmd = adj?.orders_amd ?? 0;
  const paymentsAmd = adj?.payments_amd ?? 0;
  const live = excel + ordersAmd - paymentsAmd;
  // newest first across both lists (the app orders are the newest: the Excel has not caught up with them)
  const all = [...(adj?.orders ?? []), ...excelOrders].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  // NET of the frozen credit: the frozen part is not chased, not overdue and not counted by the credit check (netDebt.js)
  const net = netDebt(live, frozenAmd);
  const aging = allocateFifo({ orders: all, debt: net, today, termDays });
  return {
    debt_amd: Math.max(0, net),
    gross_debt_amd: Math.max(0, live),
    frozen_amd: frozenApplied(live, frozenAmd),
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
export const UNRECORDED_DAYS = 60;
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
    `SELECT p.id, p.customer_id, p.amount_amd, p.client_ref,
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
    const cur = result.get(p.customer_id) ?? { amount: 0, count: 0, items: [] };
    cur.amount += Number(p.amount_amd);
    cur.count += 1;
    cur.items.push({ id: p.id, amount: Number(p.amount_amd), client_ref: p.client_ref });
    result.set(p.customer_id, cur);
  }
  return result;
}

