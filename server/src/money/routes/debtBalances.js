import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { erpSyncFreshness } from "../../erp/erpSyncFreshness.js";
import { allocateFifo, loadOrdersNewestFirst } from "../debtAging.js";
import { yerevanToday } from "../../utils/yerevanDate.js";
import { repVisitSql } from "../../field/visitCount.js";

export const debtBalancesRouter = Router();

debtBalancesRouter.use(requireAuth);

// Read-only view over the ERP-synced debt data (erp_customer_data.debt_amd)
// -- no write-back to ERP/Excel, no new ledger. See task item 4: this is
// deliberately kept out of the payment-approval/aging-workflow scope that
// migration 051's comment block explicitly rejected.
//
// A sales_manager only sees their own book (customers.assigned_manager_id);
// every other role (sales_director/admin/ceo/accountant) sees the full
// company-wide list, same visibility line used for financial data
// elsewhere (see seesFinancialExports in roles.js) -- accountant is
// included explicitly by the task spec even though seesFinancialExports
// already covers it.
// Same shape customers.js uses for its own last-visit column, kept
// identical on purpose so the two screens can never report a different
// "last visit" for the same customer.
const LAST_VISIT_SUBQUERY = `(SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id AND ${repVisitSql("ch")})`;

// The ERP sync's own last_payment_date routinely lags or is simply blank
// for a customer whose most recent payment was logged in-app (a cash
// collection recorded on a check-in, or a standalone payment) rather than
// through the Excel/ERP pipeline -- reported as "last payment date isn't
// showing". Only 'approved' payments count as a real collection (same
// status filter reports.js uses for every other payments aggregate), and
// the instant is converted to the business's own calendar date (Yerevan
// time, not the database's UTC session) before comparing against the
// ERP date -- both sides need to be a plain date, not a timestamp, or
// GREATEST() below would silently promote the result to a timestamptz
// and reintroduce the exact UTC-midnight day-shift bug formatDateOnly on
// the client was written to avoid.
const LAST_APP_PAYMENT_SUBQUERY = `(
  SELECT max((p.payment_date AT TIME ZONE 'Asia/Yerevan')::date)
  FROM payments p
  WHERE p.customer_id = c.id AND p.status = 'approved'
)`;

// The ERP sync's customers[].last_payment_date field (-> ecd.last_payment_date
// above) comes from whatever single column the external Excel pipeline
// happens to compute it from -- reported live as routinely blank even for
// a customer with a real, recent payment on record. erp_cashflow_lines is
// that same pipeline's full all-time cashflow history per customer (see
// docs/erp-sync-contract.md), independent of that one column, so it's
// used here as a second, more complete ERP-side source rather than trusting
// the single field alone -- the as-of branch below already had to do this
// (LAST_ERP_PAYMENT_ASOF_SUBQUERY) to compute a historical balance at all;
// this is the same thing, unbounded, for live mode. A positive cashflow
// line is a payment (a negative one is a refund paid back out, not a
// "payment" for this purpose).
const LAST_ERP_PAYMENT_SUBQUERY = `(
  SELECT max(cf.cashflow_date)
  FROM erp_cashflow_lines cf
  WHERE cf.erp_customer_id = c.erp_customer_id AND cf.amount_amd > 0
)`;

// Same as LAST_APP_PAYMENT_SUBQUERY, bounded to payments on or before the
// as-of date -- used only in the as-of branch below, where showing a
// payment that happened *after* the date being viewed would misrepresent
// what that historical balance was actually based on.
const LAST_APP_PAYMENT_ASOF_SUBQUERY = `(
  SELECT max((p.payment_date AT TIME ZONE 'Asia/Yerevan')::date)
  FROM payments p
  WHERE p.customer_id = c.id AND p.status = 'approved'
    AND (p.payment_date AT TIME ZONE 'Asia/Yerevan')::date <= $__AS_OF_DATE__
)`;

// The ERP side of "last payment", bounded the same way -- a positive
// cashflow line is a payment (a negative one is a refund, which isn't a
// "payment" for this purpose), on or before the as-of date.
const LAST_ERP_PAYMENT_ASOF_SUBQUERY = `(
  SELECT max(cf.cashflow_date)
  FROM erp_cashflow_lines cf
  WHERE cf.erp_customer_id = c.erp_customer_id AND cf.amount_amd > 0 AND cf.cashflow_date <= $__AS_OF_DATE__
)`;

// Debt as of a past date D. Originally computed as an absolute running
// balance from full order/cashflow history (SUM(orders up to D) -
// SUM(cashflow up to D), see docs/erp-sync-contract.md's cashflow_lines
// entry) -- but that assumed erp_order_lines and erp_cashflow_lines both
// carried COMPLETE all-time history from the same starting point. Reported
// live: picking today as the as-of date (which should equal "live") came
// back many times larger than the live ecd.debt_amd figure for the same
// customer. Root cause: the real sync's erp_cashflow_lines history is far
// thinner than its erp_order_lines history, so an absolute from-scratch sum
// counted ~all orders ever but only a fraction of the payments against
// them, inflating every as-of balance, worse the further back the order
// history went. Worked around for a while by anchoring on the trusted live
// debt_amd and undoing whatever happened after D instead -- correct, but
// only because it sidestepped the real gap rather than closing it.
//
// The real fix: balance0_amd (erp_customer_data, from the Castrol Excel
// Debits sheet's own "Balance0" column -- see migration 083) is the true
// opening balance carried forward from before that thin cashflow history
// began. With it, the originally-intended absolute formula is simply
// correct: balance(D) = balance0_amd + SUM(orders <= D) - SUM(cashflow <=
// D). No anchoring on live needed -- this now also holds AT D = today,
// since balance0_amd plus every order/cashflow row IS what live debt_amd
// itself was derived from on the Excel side. A customer absent from the
// live snapshot (ecd is null -- fully paid off, see the FROM-clause
// comment below) contributes a balance0_amd of 0, which is fine: whatever
// they owed as of D is still fully captured by their own order/cashflow
// history up to D.
const asOfBalanceJoin = `
  LEFT JOIN LATERAL (
    SELECT SUM(ol.revenue_amd) AS amount
    FROM erp_order_lines ol
    WHERE ol.erp_customer_id = c.erp_customer_id AND ol.order_date <= $__AS_OF_DATE__
  ) orders_asof ON true
  LEFT JOIN LATERAL (
    SELECT SUM(cf.amount_amd) AS amount
    FROM erp_cashflow_lines cf
    WHERE cf.erp_customer_id = c.erp_customer_id AND cf.cashflow_date <= $__AS_OF_DATE__
  ) cashflow_asof ON true`;
const asOfBalanceExpr = "(COALESCE(ecd.balance0_amd, 0) + COALESCE(orders_asof.amount, 0) - COALESCE(cashflow_asof.amount, 0))";

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
  const { rows: erpRows } = await db.query(
    `SELECT erp_customer_id, amount_amd, to_char(cashflow_date, 'YYYY-MM-DD') AS date
       FROM erp_cashflow_lines
      WHERE erp_customer_id = ANY($1) AND amount_amd > 0 AND cashflow_date >= (now() AT TIME ZONE 'Asia/Yerevan')::date - ($2::int + $3::int)`,
    [erpIds, UNRECORDED_DAYS, MATCH_DAYS]
  );
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

// Aging bucket of a balance, by the days its oldest unpaid invoice is past the credit term.
export function agingBucket(debt, oldestDueDays) {
  if (!(debt > 0) || oldestDueDays == null || oldestDueDays <= 0) return "current";
  if (oldestDueDays <= 30) return "d1_30";
  if (oldestDueDays <= 60) return "d31_60";
  if (oldestDueDays <= 90) return "d61_90";
  return "d90p";
}

// Amount of the customer's last payment: the workbook cashflow line of that date, or the approved in-app payment when that is newer.
function lastPaymentAmount(row, hist, app) {
  const date = row.last_payment_date ? (row.last_payment_date instanceof Date ? row.last_payment_date.toISOString() : String(row.last_payment_date)).slice(0, 10) : null;
  if (app && (!hist.last_erp_payment_date || app.date > hist.last_erp_payment_date) && (!date || app.date >= date)) return app.amount;
  if (hist.last_erp_payment_date && (!date || hist.last_erp_payment_date >= date)) return hist.last_erp_payment_amount;
  return null;
}

// One round trip per fact for ALL listed customers (never a query per row): last workbook payment, last order and its size,
// the last 12 months of orders, and the newest approved in-app payment. `asOf` bounds everything for a past date.
async function loadCustomerHistory(rows, today, asOf, db = pool) {
  const result = new Map();
  result.appPayments = new Map();
  const erpIds = rows.map((r) => r.customer_id).filter(Boolean);
  if (!erpIds.length) return result;
  const bound = asOf ?? null;
  const [pay, ord, app] = await Promise.all([
    db.query(
      `SELECT DISTINCT ON (erp_customer_id) erp_customer_id, to_char(cashflow_date, 'YYYY-MM-DD') AS d, amount_amd
         FROM erp_cashflow_lines WHERE erp_customer_id = ANY($1) AND amount_amd > 0 AND ($2::date IS NULL OR cashflow_date <= $2::date)
        ORDER BY erp_customer_id, cashflow_date DESC, id DESC`,
      [erpIds, bound]
    ),
    loadOrdersNewestFirst(db, erpIds, { asOf: bound }),
    db.query(
      `SELECT DISTINCT ON (p.customer_id) p.customer_id, to_char(p.payment_date AT TIME ZONE 'Asia/Yerevan', 'YYYY-MM-DD') AS d, p.amount_amd
         FROM payments p
        WHERE p.customer_id = ANY($1) AND p.status = 'approved' AND ($2::date IS NULL OR (p.payment_date AT TIME ZONE 'Asia/Yerevan')::date <= $2::date)
        ORDER BY p.customer_id, p.payment_date DESC, p.id DESC`,
      [rows.map((r) => r.internal_customer_id), bound]
    ),
  ]);
  for (const r of pay.rows) result.set(r.erp_customer_id, { last_erp_payment_date: r.d, last_erp_payment_amount: Number(r.amount_amd) });
  // the last order and the last 12 months, from the server's copy of the order lines (debtAging.js): one order = one order id, dated by
  // its first day
  const yearAgo = new Date(Date.parse(`${String(today).slice(0, 10)}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10);
  for (const [erpId, list] of ord) {
    const byOrder = new Map();
    for (const o of list) {
      const cur = byOrder.get(o.order_id);
      if (cur) {
        cur.total += o.total;
        if (o.date < cur.date) cur.date = o.date;
      } else byOrder.set(o.order_id, { order_id: o.order_id, date: o.date, total: o.total });
    }
    let last = null;
    let year = 0;
    for (const o of byOrder.values()) {
      if (!last || o.date > last.date || (o.date === last.date && o.order_id > last.order_id)) last = o;
      if (o.date > yearAgo) year += o.total;
    }
    const cur = result.get(erpId) ?? {};
    result.set(erpId, { ...cur, last_order_date: last.date, last_order_amount: last.total, orders_12m_amd: year });
  }
  for (const r of app.rows) result.appPayments.set(r.customer_id, { date: r.d, amount: Number(r.amount_amd) });
  return result;
}

debtBalancesRouter.get("/", async (req, res) => {
  const { date } = req.query;
  const asOfDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;

  const params = [];
  // Live mode drives from erp_customer_data (today's synced snapshot) same
  // as always. As-of mode must NOT: that table is TRUNCATE-and-replaced on
  // every sync and silently drops a customer once their debt is fully
  // paid off (see migration 006's own comment on erp_customer_data), even
  // though they can genuinely have owed money as of an earlier date --
  // this was reported live as "by date" balances coming out wrong/missing
  // customers that "live" shows correctly, because the as-of calculation
  // was accidentally scoped to whoever still happens to be in *today's*
  // snapshot instead of full history. Driving from `customers` instead
  // (with erp_customer_data only an optional left join, used solely for
  // whichever of its columns a still-current row happens to have) makes
  // the as-of balance independent of what the live snapshot currently
  // contains.
  let fromClause = `
     FROM erp_customer_data ecd
     JOIN customers c ON c.erp_customer_id = ecd.erp_customer_id`;
  let where = asOfDate ? "WHERE c.erp_customer_id IS NOT NULL" : "WHERE ecd.debt_amd IS NOT NULL AND ecd.debt_amd <> 0";
  if (asOfDate) {
    fromClause = `
     FROM customers c
     LEFT JOIN erp_customer_data ecd ON ecd.erp_customer_id = c.erp_customer_id`;
  }

  if (req.user.role === "sales_manager") {
    params.push(req.user.id);
    where += ` AND c.assigned_manager_id = $${params.length}`;
  }

  let balanceJoin = "";
  let balanceExpr = "ecd.debt_amd";
  let lastPaymentExpr = `GREATEST(ecd.last_payment_date, ${LAST_APP_PAYMENT_SUBQUERY}, ${LAST_ERP_PAYMENT_SUBQUERY})`;
  if (asOfDate) {
    params.push(asOfDate);
    const dateParam = `$${params.length}`;
    balanceJoin = asOfBalanceJoin.replaceAll("$__AS_OF_DATE__", dateParam);
    balanceExpr = asOfBalanceExpr;
    where += ` AND ${balanceExpr} <> 0`;
    lastPaymentExpr = `GREATEST(${LAST_ERP_PAYMENT_ASOF_SUBQUERY}, ${LAST_APP_PAYMENT_ASOF_SUBQUERY})`.replaceAll(
      "$__AS_OF_DATE__",
      dateParam
    );
  }

  const { rows } = await pool.query(
    `SELECT c.id AS internal_customer_id,
            c.erp_customer_id AS customer_id,
            c.name AS customer_name,
            ${balanceExpr} AS remaining_balance,
            ${lastPaymentExpr} AS last_payment_date,
            ${LAST_VISIT_SUBQUERY} AS last_visit_at,
            c.assigned_manager_id, c.credit_term_days, c.sales_channel,
            am.name AS assigned_manager_name
     ${fromClause}
     LEFT JOIN users am ON am.id = c.assigned_manager_id
     ${balanceJoin}
     ${where}
     ORDER BY remaining_balance DESC`,
    params
  );
  // FIFO aging per customer (payments clear the oldest invoices first, credit term deducted -- see
  // debtAging.js): the oldest unpaid invoice's days past due and the overdue part of the balance.
  const today = asOfDate ?? yerevanToday();
  // The four follow-up reads depend only on the rows: they run at the same time (owner, 2026-10-29: the slowest screen to load).
  const [orders, unrecorded, history, sync] = await Promise.all([
    loadOrdersNewestFirst(pool, rows.filter((r) => Number(r.remaining_balance) > 0).map((r) => r.customer_id), { asOf: asOfDate }),
    // Money the reps collected in the app that the Excel (ERP) does not hold yet (live view only -- a past date has no "yet").
    asOfDate ? new Map() : loadUnrecordedPayments(rows, req.user),
    loadCustomerHistory(rows, today, asOfDate),
    erpSyncFreshness("erp_customer_data"),
  ]);
  const withAging = rows.map(({ credit_term_days, ...r }) => {
    const a = allocateFifo({ orders: orders.get(r.customer_id) ?? [], debt: Number(r.remaining_balance), today, termDays: credit_term_days ?? 45 });
    const u = unrecorded.get(r.internal_customer_id);
    const h = history.get(r.customer_id) ?? {};
    const debt = Number(r.remaining_balance);
    return {
      ...r,
      oldest_due_days: a.oldest_due_days,
      overdue_amd: a.overdue_amd,
      unrecorded_amd: u?.amount ?? 0,
      unrecorded_count: u?.count ?? 0,
      last_payment_amount: lastPaymentAmount(r, h, history.appPayments.get(r.internal_customer_id)),
      last_order_date: h.last_order_date ?? null,
      last_order_amount: h.last_order_amount ?? null,
      orders_12m_amd: h.orders_12m_amd ?? 0,
      // How big the debt is next to what the customer bought in the last 12 months: 100 % = owes a whole year of purchases.
      debt_pct_of_orders: debt > 0 && h.orders_12m_amd > 0 ? Math.round((debt / h.orders_12m_amd) * 100) : null,
      bucket: agingBucket(debt, a.oldest_due_days),
    };
  });
  res.json({ rows: withAging, as_of_date: asOfDate, sync });
});
