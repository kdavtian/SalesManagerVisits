// "Recorded": the final order status (owner, 2026-11-11). After an order is delivered, the accountant (or the CEO / admin) checks it and gives it
// the status Recorded; an order the ERP sync finds in the Excel is recorded by itself (the Excel proves it). Recorded is "delivered and booked":
// every rule that counts a delivered order (live debt, stock held until the Excel shows it, reports, returns) counts a recorded one the same way,
// through DONE_SQL / isDone below -- never by comparing with 'delivered' alone.
//
// orders.recorded (the old tick, migration 051) is kept in step with the status (recorded = true exactly when status = 'recorded'), so old phones
// and the old Recorded screen keep working during a deploy.
export const DONE_STATUSES = ["delivered", "recorded"];
export const DONE_SQL = "('delivered', 'recorded')";
export const isDone = (status) => DONE_STATUSES.includes(status);

// delivered -> recorded. `db` is a pool or a client inside a transaction. userId null = the system (found in the Excel). Returns the updated row,
// or null when the order is not delivered (already recorded, or not delivered yet). updated_at is left alone on purpose: it stands in for the
// delivery time where no history row exists (appStock.js DELIVERED_AT).
export async function recordOrder(db, orderId, { userId = null, reason }) {
  const { rows } = await db.query(
    `UPDATE orders SET status = 'recorded', recorded = true, recorded_by = $2, recorded_at = now(), not_in_excel_at = NULL
     WHERE id = $1 AND status = 'delivered' RETURNING *`,
    [orderId, userId]
  );
  if (!rows[0]) return null;
  await db.query(
    `INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by) VALUES ($1, 'delivered', 'recorded', $2, $3)`,
    [orderId, reason, userId]
  );
  return rows[0];
}

// recorded -> delivered (a mistake undone). Returns the updated row, or null when the order is not recorded.
export async function unrecordOrder(db, orderId, { userId }) {
  const { rows } = await db.query(
    `UPDATE orders SET status = 'delivered', recorded = false, recorded_by = NULL, recorded_at = NULL WHERE id = $1 AND status = 'recorded' RETURNING *`,
    [orderId]
  );
  if (!rows[0]) return null;
  await db.query(
    `INSERT INTO order_status_history (order_id, old_status, new_status, reason, changed_by) VALUES ($1, 'recorded', 'delivered', 'Recorded status removed', $2)`,
    [orderId, userId]
  );
  return rows[0];
}
