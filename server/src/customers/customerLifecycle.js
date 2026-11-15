// A customer's life after it is created: what keeps it from being deleted, closing and reopening it.

// What keeps a customer from being deleted (the ON DELETE RESTRICT links): its payments, old and new (a voided new payment still
// counts: payments are voided, never deleted), and KAD OS accounts linked to it. Named with numbers so the admin knows what to clear.
export async function customerDeleteBlockers(db, customerId) {
  const { rows: [p] } = await db.query(
    `SELECT (SELECT count(*) FROM payments WHERE customer_id = $1)::int
          + (SELECT count(*) FROM customer_payments WHERE customer_id = $1)::int AS payments,
            COALESCE((SELECT sum(amount_amd) FROM payments WHERE customer_id = $1 AND status <> 'rejected'), 0)::float8
          + COALESCE((SELECT sum(amount_amd) FROM customer_payments WHERE customer_id = $1 AND voided_at IS NULL), 0)::float8 AS payments_amd`,
    [customerId]
  );
  const { rows: links } = await db.query(
    "SELECT u.id, u.name FROM partner_links pl JOIN users u ON u.id = pl.user_id WHERE pl.customer_id = $1 ORDER BY u.name",
    [customerId]
  );
  return { payments: p.payments, payments_amd: Math.round(p.payments_amd), kad_os_accounts: links.map((l) => l.name) };
}

// The plans that list customers in a plain integer array (Postgres cannot foreign-key those): a customer that is deleted or closed
// leaves them, or it lingers as a ghost stop on a rep's plan.
export async function removeFromPlans(db, customerId) {
  await db.query("UPDATE visit_plans SET customer_ids = array_remove(customer_ids, $1) WHERE $1 = ANY(customer_ids)", [customerId]);
  await db.query("UPDATE visit_plan_rules SET customer_ids = array_remove(customer_ids, $1) WHERE $1 = ANY(customer_ids)", [customerId]);
  await db.query("UPDATE route_plan_set_rules SET customer_ids = array_remove(customer_ids, $1) WHERE $1 = ANY(customer_ids)", [customerId]);
}

// Close (owner, 2026-11-15): the place stopped working with us. It leaves field work -- lists, map, visit / route plans, reminders, new
// orders and visits -- and keeps its history, payments and debt (a payment can still be recorded on it). Reversible with reopenCustomer.
// Returns the row, null when there is no such customer, or { already: true } when it was closed before.
export async function closeCustomer(pool, customerId, userId, reason) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: [c] } = await client.query("SELECT id, closed_at FROM customers WHERE id = $1 FOR UPDATE", [customerId]);
    if (!c) {
      await client.query("ROLLBACK");
      return null;
    }
    if (c.closed_at) {
      await client.query("ROLLBACK");
      return { already: true };
    }
    const { rows: [row] } = await client.query(
      "UPDATE customers SET closed_at = now(), closed_by = $2, close_reason = $3 WHERE id = $1 RETURNING id, closed_at, closed_by, close_reason",
      [customerId, userId, reason]
    );
    // Only what is still ahead: past visit plans are history (payroll / KPI adherence count their stops), and a saved route plan set
    // that is not active keeps the customer (a closed one is skipped when that set is activated, and is back there after a reopen).
    await client.query(
      "UPDATE visit_plans SET customer_ids = array_remove(customer_ids, $1) WHERE $1 = ANY(customer_ids) AND plan_date >= (now() AT TIME ZONE 'Asia/Yerevan')::date",
      [customerId]
    );
    await client.query("UPDATE visit_plan_rules SET customer_ids = array_remove(customer_ids, $1) WHERE $1 = ANY(customer_ids)", [customerId]);
    await client.query(
      `UPDATE route_plan_set_rules SET customer_ids = array_remove(customer_ids, $1)
       WHERE $1 = ANY(customer_ids) AND set_id IN (SELECT id FROM route_plan_sets WHERE is_active)`,
      [customerId]
    );
    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Reopen: back in field work. The plans it left are not restored by hand: the caller places it like a new customer (auto route plan).
// Returns the row, null when there is no such customer, or { notClosed: true } (a stale second tap must not re-place an open customer).
export async function reopenCustomer(db, customerId) {
  const { rows: [row] } = await db.query(
    "UPDATE customers SET closed_at = NULL, closed_by = NULL, close_reason = NULL WHERE id = $1 AND closed_at IS NOT NULL RETURNING id",
    [customerId]
  );
  if (row) return row;
  const { rows: [exists] } = await db.query("SELECT 1 FROM customers WHERE id = $1", [customerId]);
  return exists ? { notClosed: true } : null;
}

export const CUSTOMER_CLOSED_ERROR = { error: "This customer is closed. Reopen it first.", code: "customer_closed" };
