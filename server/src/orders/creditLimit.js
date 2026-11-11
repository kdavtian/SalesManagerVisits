// Credit-limit check (migration 101). Exposure of a customer if one more
// order of `totalAmd` is accepted:
//   Excel debt (erp_customer_data.debt_amd, may be negative = prepaid)
//   + other app orders that Excel does not know yet (submitted / confirmed /
//     packed, and delivered but not found in the Excel: liveDebt.js)
//   + this order.
// No limit set (NULL) means no check. Pure SQL helpers take any pg client/pool.
import { liveAdjustments } from "../money/liveDebt.js";
import { netDebt, frozenApplied } from "../shared/netDebt.js";

export async function creditSnapshot(db, customerId, excludeOrderId = null) {
  const { rows } = await db.query(
    `SELECT c.credit_limit_amd, c.frozen_credit_amd::float8 AS frozen_amd, COALESCE(erp.debt_amd, 0) AS debt_amd,
            COALESCE((SELECT SUM(o.total_amd) FROM orders o
                      WHERE o.customer_id = c.id AND ($2::int IS NULL OR o.id <> $2)
                        AND o.cancelled_at IS NULL AND o.status IN ('submitted', 'confirmed', 'packed_stock_out')), 0) AS open_orders_amd
     FROM customers c
     LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     WHERE c.id = $1`,
    [customerId, excludeOrderId]
  );
  const row = rows[0];
  if (!row) return null;
  // Release 4 (owner, 2026-11-02: the live debt everywhere): payments the Excel does not have yet (cash in the app, bank / card in Bank &
  // cash desks) lower the exposure, so a customer who has just paid can order again before the accountant enters it.
  const adj = (await liveAdjustments(db, [customerId])).get(Number(customerId));
  const paid = adj?.payments_amd ?? 0;
  // delivered app orders the Excel does not show yet: the live debt's own list (owner, 2026-11-11: "same rule for the credit check"). It used
  // "delivered and changed after the customer's last sync", which counted a delivered order the Excel already holds a second time.
  const deliveredNotInExcel = (adj?.orders ?? []).filter((o) => o.app_order_id !== Number(excludeOrderId)).reduce((sum, o) => sum + o.total, 0);
  const liveDebt = Number(row.debt_amd) - paid;
  return {
    limit: row.credit_limit_amd === null ? null : Number(row.credit_limit_amd),
    // NET debt only (owner, 2026-11-03): the frozen credit is not counted against the limit (netDebt.js)
    debt: netDebt(liveDebt, row.frozen_amd),
    grossDebt: liveDebt,
    frozen: frozenApplied(liveDebt, row.frozen_amd),
    excelDebt: Number(row.debt_amd),
    paymentsNotInExcel: paid,
    openOrders: Number(row.open_orders_amd) + deliveredNotInExcel,
  };
}

// { limit, debt, openOrders, exposure, exceeded, over }
export async function evaluateCredit(db, customerId, totalAmd, excludeOrderId = null) {
  const snap = await creditSnapshot(db, customerId, excludeOrderId);
  if (!snap) return null;
  const exposure = snap.debt + snap.openOrders + Number(totalAmd);
  const exceeded = snap.limit !== null && exposure > snap.limit;
  return { ...snap, exposure, exceeded, over: exceeded ? exposure - snap.limit : 0 };
}
