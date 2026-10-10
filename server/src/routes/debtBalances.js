import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { erpSyncFreshness } from "../erpSyncFreshness.js";
import { allocateFifo, loadOrdersNewestFirst } from "../debtAging.js";
import { yerevanToday } from "../utils/yerevanDate.js";

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
const LAST_VISIT_SUBQUERY = `(SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id AND ch.within_range)`;

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
            c.assigned_manager_id, c.credit_term_days,
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
  const orders = await loadOrdersNewestFirst(pool, rows.filter((r) => Number(r.remaining_balance) > 0).map((r) => r.customer_id), { asOf: asOfDate });
  const withAging = rows.map(({ credit_term_days, ...r }) => {
    const a = allocateFifo({ orders: orders.get(r.customer_id) ?? [], debt: Number(r.remaining_balance), today, termDays: credit_term_days ?? 45 });
    return { ...r, oldest_due_days: a.oldest_due_days, overdue_amd: a.overdue_amd };
  });
  res.json({ rows: withAging, as_of_date: asOfDate, sync: await erpSyncFreshness("erp_customer_data") });
});
