import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

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

debtBalancesRouter.get("/", async (req, res) => {
  const params = [];
  let where = "WHERE ecd.debt_amd IS NOT NULL AND ecd.debt_amd <> 0";
  if (req.user.role === "sales_manager") {
    params.push(req.user.id);
    where += ` AND c.assigned_manager_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT c.id AS internal_customer_id,
            c.erp_customer_id AS customer_id,
            c.name AS customer_name,
            ecd.debt_amd AS remaining_balance,
            GREATEST(ecd.last_payment_date, ${LAST_APP_PAYMENT_SUBQUERY}) AS last_payment_date,
            ${LAST_VISIT_SUBQUERY} AS last_visit_at,
            c.assigned_manager_id,
            am.name AS assigned_manager_name
     FROM erp_customer_data ecd
     JOIN customers c ON c.erp_customer_id = ecd.erp_customer_id
     LEFT JOIN users am ON am.id = c.assigned_manager_id
     ${where}
     ORDER BY ecd.debt_amd DESC`,
    params
  );
  res.json(rows);
});
