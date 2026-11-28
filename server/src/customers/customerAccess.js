// "May this user reach this customer?" -- ONE rule for every route that takes a customer id (improvement plan 0.11 / 0.12, owner rule
// 2026-11-04: "a rep sees only the customers assigned to him"). A role that sees all activity (roles.js seesAllActivity: everyone but the
// sales manager) reaches every customer; a sales manager reaches his own customers (assigned_manager_id) and the offices every rep checks in
// at (checkin_for_all). Nothing else: no unassigned / prospect exception exists in the card guard this was taken from, so none is added here.
import { pool } from "../db/pool.js";
import { seesAllActivity } from "../shared/roles.js";

/** The rule on a customer row that carries assigned_manager_id and checkin_for_all. */
export function mayReachCustomerRow(user, customer) {
  if (seesAllActivity(user.role)) return true;
  return Boolean(customer && (customer.checkin_for_all || customer.assigned_manager_id === user.id));
}

/** "ok" | "missing" (no such customer) | "denied". Callers answer "denied" with 404 (the card does: existence not revealed) or 403. */
export async function customerAccess(user, customerId, db = pool) {
  const id = Number(customerId);
  if (!Number.isInteger(id)) return "missing";
  if (seesAllActivity(user.role)) return "ok";
  const { rows: [c] } = await db.query("SELECT assigned_manager_id, checkin_for_all FROM customers WHERE id = $1", [id]);
  if (!c) return "missing";
  return mayReachCustomerRow(user, c) ? "ok" : "denied";
}

/** SQL condition limiting customer alias `alias` to what the user reaches; `$n` is the user's id (push it yourself). "" when unrestricted. */
export function reachableCustomersSql(user, alias, n) {
  if (seesAllActivity(user.role)) return "";
  return `(${alias}.assigned_manager_id = $${n} OR COALESCE(${alias}.checkin_for_all, false))`;
}

/**
 * A signed accounting document of an order (order_documents): the people who see all activity, the rep who placed the order, and anyone who
 * reaches the order's customer -- exactly what the customer card's Documents list shows them, so every listed paper also opens.
 * Returns null when the order does not exist.
 */
export async function mayOpenOrderDocument(user, orderId, db = pool) {
  const { rows: [o] } = await db.query(
    "SELECT o.user_id, c.assigned_manager_id, c.checkin_for_all FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1",
    [orderId]
  );
  if (!o) return null;
  return seesAllActivity(user.role) || o.user_id === user.id || mayReachCustomerRow(user, o);
}
