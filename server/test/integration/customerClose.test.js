// Close / reopen a customer (customers/customerLifecycle.js; owner, 2026-11-15: a customer with payments cannot be deleted, so it is
// closed instead). Closed = out of the lists, the map, the plans and new orders; history, payments and the card stay; reopen undoes it.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackPayment } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let cookies;
let users;
const planIds = [];

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "sales_manager", "sales_director"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
});
test.after(async () => {
  if (planIds.length) await pool.query("DELETE FROM visit_plans WHERE id = ANY($1)", [planIds]);
  await cleanupAll();
  await stopTestServer();
});

const listIds = async (query = "") => {
  const res = await apiRequest(`/api/customers${query}`, { cookie: cookies.admin });
  assert.equal(res.status, 200);
  return res.data.map((c) => c.id);
};

test("close: a customer with payments leaves the lists, the plans and new orders, keeps its card; reopen brings it back", async () => {
  const customer = await createCustomer({ created_by: users.admin.id, assigned_manager_id: users.sales_manager.id, name: "Close Test Garage" });
  const { rows: [pay] } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by)
     VALUES ($1, $2, 5000, now(), $3, $4, 'pending', $3) RETURNING id`,
    [customer.id, customer.name, users.admin.id, users.admin.name]
  );
  trackPayment(pay.id);
  const { rows: [plan] } = await pool.query(
    "INSERT INTO visit_plans (user_id, plan_date, customer_ids, status, created_by) VALUES ($1, current_date + 1, $2, 'approved', $1) RETURNING id",
    [users.sales_manager.id, [customer.id]]
  );
  planIds.push(plan.id);

  // the reason is required
  assert.equal((await apiRequest(`/api/customers/${customer.id}/close`, { method: "POST", body: { reason: "  " }, cookie: cookies.admin })).status, 400);
  const closed = await apiRequest(`/api/customers/${customer.id}/close`, { method: "POST", body: { reason: "The shop closed" }, cookie: cookies.admin });
  assert.equal(closed.status, 200);
  assert.ok(closed.data.closed_at);
  // twice: a clean 409
  assert.equal((await apiRequest(`/api/customers/${customer.id}/close`, { method: "POST", body: { reason: "again" }, cookie: cookies.admin })).status, 409);

  // out of the default list, in closed=only and closed=1
  assert.ok(!(await listIds()).includes(customer.id), "hidden from the list / map");
  assert.ok((await listIds("?closed=only")).includes(customer.id));
  assert.ok((await listIds("?closed=1&search=Close%20Test%20Garage")).includes(customer.id), "a payment picker still finds it");

  // off the visit plan
  const { rows: [p] } = await pool.query("SELECT customer_ids FROM visit_plans WHERE id = $1", [plan.id]);
  assert.deepEqual(p.customer_ids, []);

  // the card still opens, says who / when / why, and needs no visit
  const card = await apiRequest(`/api/customers/${customer.id}`, { cookie: cookies.admin });
  assert.equal(card.status, 200);
  assert.equal(card.data.close_reason, "The shop closed");
  assert.equal(card.data.closed_by_name, users.admin.name);
  assert.equal(card.data.requires_visit, false);

  // no new order
  const order = await apiRequest("/api/orders", { method: "POST", body: { customer_id: customer.id, items: [{ product_id: 1, quantity: 1 }], payment_method: "cash" }, cookie: cookies.sales_manager });
  assert.equal(order.status, 409);
  assert.equal(order.data.code, "customer_closed");

  // the payment is still there, the customer still cannot be deleted
  const del = await apiRequest(`/api/customers/${customer.id}`, { method: "DELETE", cookie: cookies.admin });
  assert.equal(del.status, 409);
  assert.equal(del.data.code, "customer_has_records");

  // reopen
  const reopened = await apiRequest(`/api/customers/${customer.id}/reopen`, { method: "POST", body: {}, cookie: cookies.admin });
  assert.equal(reopened.status, 200);
  assert.ok((await listIds()).includes(customer.id));
  const { rows: [c] } = await pool.query("SELECT closed_at, closed_by, close_reason FROM customers WHERE id = $1", [customer.id]);
  assert.deepEqual(c, { closed_at: null, closed_by: null, close_reason: null });
});

test("close / reopen: only the roles that may close customers (admin); others get 403, an unknown id 404", async () => {
  // the rep's own customer: a rep may see it, and still may not close it
  const customer = await createCustomer({ created_by: users.admin.id, assigned_manager_id: users.sales_manager.id });
  for (const role of ["sales_director", "sales_manager"]) {
    assert.equal((await apiRequest(`/api/customers/${customer.id}/close`, { method: "POST", body: { reason: "x" }, cookie: cookies[role] })).status, 403, role);
    assert.equal((await apiRequest(`/api/customers/${customer.id}/reopen`, { method: "POST", body: {}, cookie: cookies[role] })).status, 403, role);
  }
  assert.equal((await apiRequest("/api/customers/999999999/close", { method: "POST", body: { reason: "x" }, cookie: cookies.admin })).status, 404);
  assert.equal((await apiRequest("/api/customers/999999999/reopen", { method: "POST", body: {}, cookie: cookies.admin })).status, 404);
});
