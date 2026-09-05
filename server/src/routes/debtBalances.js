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
debtBalancesRouter.get("/", async (req, res) => {
  const params = [];
  let where = "WHERE ecd.debt_amd IS NOT NULL AND ecd.debt_amd <> 0";
  if (req.user.role === "sales_manager") {
    params.push(req.user.id);
    where += ` AND c.assigned_manager_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT c.erp_customer_id AS customer_id,
            c.name AS customer_name,
            ecd.debt_amd AS remaining_balance,
            ecd.last_payment_date,
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
