// Admin "delete a TEST user and everything connected to them". The normal user delete refuses accounts with activity
// (audit trail), which left throwaway test accounts undeletable. This is the deliberate escape hatch: allowed only for
// accounts whose NAME says "test", never your own, and it shows exactly what goes first (previewPurge).
//
// Deleted: the user's check-ins/visits, orders, payments (+ cash handoffs they sent/received), delivery work, cash
// expenses, performance plans, edit requests -- and the customers the user created WITHOUT an ERP id (test customers)
// with all the orders/payments/visits on them. KEPT (handed over): customers with an ERP id the user created (they
// move to the admin doing this), plans the user wrote for other reps, customers merely assigned to the user (unassigned).
import { handOverTasks } from "./taskHandover.js";

const TEST_NAME = /test|թեստ|тест/i;

// By NAME only: an e-mail such as "contest@..." must not make a real account purgeable.
export function isTestUser(user) {
  return TEST_NAME.test(user.name ?? "");
}

async function ids(db, sql, params) {
  const { rows } = await db.query(sql, params);
  return rows.map((r) => r.id);
}

// What the purge touches. db = pool or a transaction client.
async function collect(db, userId) {
  const customers = await ids(db, "SELECT id FROM customers WHERE created_by = $1 AND erp_customer_id IS NULL", [userId]);
  const payments = await ids(
    db,
    "SELECT id FROM payments WHERE sales_manager_id = $1 OR created_by = $1 OR customer_id = ANY($2)",
    [userId, customers]
  );
  const orders = await ids(db, "SELECT id FROM orders WHERE user_id = $1 OR customer_id = ANY($2)", [userId, customers]);
  return { customers, payments, orders };
}

export async function previewPurge(db, userId) {
  const { customers, payments, orders } = await collect(db, userId);
  // one after another: db may be a single transaction client, which runs one query at a time
  const queries = [
    ["SELECT COALESCE(sum(total_amd), 0)::float8 AS amount FROM orders WHERE id = ANY($1)", [orders]],
    ["SELECT COALESCE(sum(amount_amd), 0)::float8 AS amount FROM payments WHERE id = ANY($1)", [payments]],
    ["SELECT count(*)::int AS n FROM checkins WHERE user_id = $1 OR customer_id = ANY($2)", [userId, customers]],
    ["SELECT count(*)::int AS n FROM customers WHERE created_by = $1 AND erp_customer_id IS NOT NULL", [userId]],
    ["SELECT count(*)::int AS n FROM customers WHERE assigned_manager_id = $1 AND NOT (id = ANY($2))", [userId, customers]],
    ["SELECT count(*)::int AS n FROM cash_handoffs WHERE from_user_id = $1 OR to_user_id = $1 OR submitted_by = $1", [userId]],
    ["SELECT count(*)::int AS n FROM delivery_routes WHERE created_by = $1 OR driver_id = $1", [userId]],
    ["SELECT count(*)::int AS n FROM cash_expenses WHERE user_id = $1", [userId]],
    ["SELECT count(*)::int AS n FROM perf_plans WHERE created_by = $1", [userId]],
    [
      "SELECT ((SELECT count(*) FROM visit_plans WHERE created_by = $1 AND user_id <> $1) + (SELECT count(*) FROM visit_plan_rules WHERE created_by = $1 AND user_id <> $1))::int AS n",
      [userId],
    ],
  ];
  const results = [];
  for (const [sql, params] of queries) results.push((await db.query(sql, params)).rows[0]);
  const [orderSum, paySum, checkins, keptCustomers, assignedOnly, handoffs, routes, expenses, perfPlans, plansForOthers] = results;
  return {
    willDelete: {
      customers: customers.length,
      checkins: checkins.n,
      orders: orders.length,
      orders_amount_amd: Math.round(orderSum.amount),
      payments: payments.length,
      payments_amount_amd: Math.round(paySum.amount),
      cash_handoffs: handoffs.n,
      delivery_routes: routes.n,
      cash_expenses: expenses.n,
      perf_plans: perfPlans.n,
    },
    willKeep: {
      customers_with_erp_id_handed_to_you: keptCustomers.n,
      customers_only_assigned_unassigned: assignedOnly.n,
      plans_written_for_other_reps_handed_to_you: plansForOthers.n,
    },
  };
}

// Runs inside the caller's transaction (client). adminId receives what is kept.
export async function purgeUser(client, userId, adminId) {
  const { customers, payments, orders } = await collect(client, userId);
  const run = (sql, params) => client.query(sql, params);

  // money first: handoff items and payments are RESTRICT-linked
  await run("DELETE FROM cash_handoff_items WHERE payment_id = ANY($1)", [payments]);
  await run("DELETE FROM cash_handoffs WHERE from_user_id = $1 OR to_user_id = $1 OR submitted_by = $1", [userId]);
  await run("UPDATE cash_handoffs SET confirmed_by = NULL WHERE confirmed_by = $1", [userId]);
  await run("UPDATE cash_handoffs SET rejected_by = NULL WHERE rejected_by = $1", [userId]);
  await run("DELETE FROM payments WHERE id = ANY($1)", [payments]);

  // deliveries and orders
  await run("DELETE FROM pod_records WHERE driver_id = $1 OR order_id = ANY($2)", [userId, orders]);
  await run("DELETE FROM delivery_routes WHERE created_by = $1 OR driver_id = $1", [userId]);
  await run("DELETE FROM orders WHERE id = ANY($1)", [orders]);

  // visits and the user's own activity
  await run("DELETE FROM checkin_far_attempts WHERE user_id = $1", [userId]);
  await run("DELETE FROM checkins WHERE user_id = $1", [userId]);
  await run("DELETE FROM cash_expenses WHERE user_id = $1", [userId]);
  await run("DELETE FROM customer_edit_requests WHERE requested_by = $1", [userId]);
  await run("UPDATE customer_edit_requests SET reviewed_by = NULL WHERE reviewed_by = $1", [userId]);
  await run("UPDATE visit_plans SET reviewed_by = NULL WHERE reviewed_by = $1", [userId]);
  for (const col of ["submitted_by", "approved_by", "closed_by"]) await run(`UPDATE perf_plans SET ${col} = NULL WHERE ${col} = $1`, [userId]);
  await run("UPDATE perf_plans SET supersedes_plan_id = NULL WHERE supersedes_plan_id IN (SELECT id FROM perf_plans WHERE created_by = $1)", [userId]);
  await run("DELETE FROM perf_plan_audit WHERE actor_id = $1", [userId]);
  await run("DELETE FROM perf_plan_comments WHERE author_id = $1", [userId]);
  await run("DELETE FROM perf_plans WHERE created_by = $1", [userId]);

  // what stays goes to the admin
  await run("UPDATE visit_plans SET created_by = $2 WHERE created_by = $1", [userId, adminId]);
  await run("UPDATE visit_plan_rules SET created_by = $2 WHERE created_by = $1", [userId, adminId]);
  await run("UPDATE customers SET created_by = $2 WHERE created_by = $1 AND erp_customer_id IS NOT NULL", [userId, adminId]);
  await run("UPDATE customers SET assigned_manager_id = NULL WHERE assigned_manager_id = $1 AND NOT (id = ANY($2))", [userId, customers]);
  await run("DELETE FROM customers WHERE id = ANY($1)", [customers]);
  await handOverTasks(client, userId); // the tasks stay, with the next manager (taskHandover.js)
  await run("DELETE FROM users WHERE id = $1", [userId]);
}
