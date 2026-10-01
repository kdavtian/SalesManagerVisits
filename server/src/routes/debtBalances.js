import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { erpSyncFreshness } from "../erpSyncFreshness.js";

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
const LAST_VISIT_SUBQUERY = `(SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id)`;

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

// Debt as of a past date D, computed from full order/cashflow history
// instead of the live ecd.debt_amd snapshot -- see
// docs/erp-sync-contract.md's cashflow_lines entry. Same running-balance
// math as reports.js's /customer-debt route: SUM(orders up to D) -
// SUM(cashflow up to D), not floored at zero (a customer who paid ahead
// can genuinely show a negative/credit balance as of a given date).
//
// Keyed on c.erp_customer_id, not ecd.erp_customer_id -- this join is only
// ever spliced into the as-of branch below, where the FROM clause is
// swapped to drive from `customers` with erp_customer_data as an optional
// left join (see the FROM-clause comment in the handler), so ecd can be
// null for a row this still needs to match.
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
const asOfBalanceExpr = "(COALESCE(orders_asof.amount, 0) - COALESCE(cashflow_asof.amount, 0))";

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
  let lastPaymentExpr = `GREATEST(ecd.last_payment_date, ${LAST_APP_PAYMENT_SUBQUERY})`;
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
            c.assigned_manager_id,
            am.name AS assigned_manager_name
     ${fromClause}
     LEFT JOIN users am ON am.id = c.assigned_manager_id
     ${balanceJoin}
     ${where}
     ORDER BY remaining_balance DESC`,
    params
  );
  res.json({ rows, as_of_date: asOfDate, sync: await erpSyncFreshness("erp_customer_data") });
});
