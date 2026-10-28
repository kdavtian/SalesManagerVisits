// Credit-limit check (migration 101). Exposure of a customer if one more
// order of `totalAmd` is accepted:
//   Excel debt (erp_customer_data.debt_amd, may be negative = prepaid)
//   + other app orders that Excel does not know yet (submitted / confirmed /
//     packed, and delivered since the last sync)
//   + this order.
// No limit set (NULL) means no check. Pure SQL helpers take any pg client/pool.

export async function creditSnapshot(db, customerId, excludeOrderId = null) {
  const { rows } = await db.query(
    `SELECT c.credit_limit_amd, COALESCE(erp.debt_amd, 0) AS debt_amd,
            COALESCE((SELECT SUM(o.total_amd) FROM orders o
                      WHERE o.customer_id = c.id AND ($2::int IS NULL OR o.id <> $2)
                        AND (o.status IN ('submitted', 'confirmed', 'packed_stock_out')
                             OR (o.status = 'delivered' AND (erp.synced_at IS NULL OR o.updated_at > erp.synced_at)))), 0) AS open_orders_amd
     FROM customers c
     LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     WHERE c.id = $1`,
    [customerId, excludeOrderId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    limit: row.credit_limit_amd === null ? null : Number(row.credit_limit_amd),
    debt: Number(row.debt_amd),
    openOrders: Number(row.open_orders_amd),
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
