// Number on the Accounting quick action:
// - accounting roles (accountant, directors, CEO, admin): requests Lily has not
//   finished yet -- waiting, being worked on, or stuck needing attention;
// - warehouse manager: confirmed orders whose document is already made, i.e.
//   what they can now receive and pack against;
// - everyone else (reps, drivers): no number.
import { pool } from "./db/pool.js";
import { canRequestAccountingDocs } from "./roles.js";

export async function accountingBadgeCount(user) {
  if (canRequestAccountingDocs(user.role)) {
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS count FROM orders WHERE accounting_status IN ('pending', 'in_progress', 'needs_attention') AND accounting_is_test = false"
    );
    return rows[0].count;
  }
  if (user.role === "warehouse_manager") {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM orders
       WHERE status = 'confirmed' AND accounting_is_test = false
         AND accounting_status IN ('waybill_created', 'partially_created', 'exported_unsigned', 'signed')`
    );
    return rows[0].count;
  }
  return 0;
}
