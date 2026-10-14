// Admin: delete a TEST user with everything connected (preview first). Real users are never purgeable.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let admin, adminCookie, tester, realRep, realCookie, product;
test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
  tester = await createUser("sales_manager", { name: "Test Purge Rep" });
  realRep = await createUser("sales_manager", { name: "Anna Real" });
  realCookie = await loginAs(realRep.email);
  product = await createProduct({ unit: "4L" });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});
const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;

test("only admins; only users named test; never yourself; confirmation required", async () => {
  assert.equal((await apiRequest(`/api/users/${tester.id}/purge`, { method: "POST", cookie: realCookie, body: { confirm: true } })).status, 403);
  assert.equal((await apiRequest(`/api/users/${realRep.id}/purge`, { method: "POST", cookie: adminCookie, body: { confirm: true } })).status, 403);
  assert.equal((await apiRequest(`/api/users/${admin.id}/purge`, { method: "POST", cookie: adminCookie, body: { confirm: true } })).status, 400);
  assert.equal((await apiRequest(`/api/users/${tester.id}/purge`, { method: "POST", cookie: adminCookie, body: {} })).status, 400);
  const real = await apiRequest(`/api/users/${realRep.id}/deletion-report`, { cookie: adminCookie });
  assert.equal(real.data.purgeAllowed, false);
  assert.equal(real.data.purge, null);
});

test("preview, then purge: the user's data goes, real data stays", async () => {
  const stamp = Date.now();
  const testCust = await createCustomer({ created_by: tester.id, assigned_manager_id: tester.id, name: "Purge Test Garage" });
  const erpCust = await createCustomer({ created_by: tester.id, assigned_manager_id: tester.id, erp_customer_id: `PG-${stamp}`, name: "Purge Real ERP Customer" });
  const realCustAssigned = await createCustomer({ created_by: admin.id, assigned_manager_id: tester.id, name: "Purge Assigned Only" });
  const realOrderRes = await apiRequest("/api/orders", { method: "POST", cookie: adminCookie, body: { customer_id: realCustAssigned.id, payment_method: "cash", items: [{ product_id: product.id, quantity: 1 }] } });
  assert.equal(realOrderRes.status, 201);
  const testerCookie = await loginAs(tester.email);
  const testerOrder = await apiRequest("/api/orders", { method: "POST", cookie: testerCookie, body: { customer_id: testCust.id, payment_method: "cash", items: [{ product_id: product.id, quantity: 2 }] } });
  assert.equal(testerOrder.status, 201, JSON.stringify(testerOrder.data));
  // somebody else's order on the test customer goes with the customer
  const otherOnTest = await apiRequest("/api/orders", { method: "POST", cookie: adminCookie, body: { customer_id: testCust.id, payment_method: "cash", items: [{ product_id: product.id, quantity: 1 }] } });
  assert.equal(otherOnTest.status, 201);
  await pool.query("INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range) VALUES ($1, $2, 40.18, 44.51, 5, true), ($3, $2, 40.18, 44.51, 5, true)", [testCust.id, tester.id, erpCust.id]);
  const pay = await pool.query(
    "INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, created_by, status) VALUES ($1, 'x', 25000, now(), $2, 'T', $2, 'approved') RETURNING id",
    [erpCust.id, tester.id]
  );
  const handoff = await pool.query("INSERT INTO cash_handoffs (from_user_id, to_user_id, amount_amd, submitted_by) VALUES ($1, $2, 25000, $1) RETURNING id", [tester.id, admin.id]);
  await pool.query("INSERT INTO cash_handoff_items (handoff_id, payment_id) VALUES ($1, $2)", [handoff.rows[0].id, pay.rows[0].id]);
  await pool.query("INSERT INTO cash_expenses (user_id, amount_amd, purpose) VALUES ($1, 1000, 'fuel')", [tester.id]);
  await pool.query("INSERT INTO perf_plans (month, created_by) VALUES (make_date(2100 + (random() * 900)::int, 1 + (random() * 11)::int, 1), $1)", [tester.id]);
  await pool.query("INSERT INTO delivery_routes (driver_id, route_date, created_by) VALUES ($1, current_date, $1)", [tester.id]);

  const report = await apiRequest(`/api/users/${tester.id}/deletion-report`, { cookie: adminCookie });
  assert.equal(report.data.purgeAllowed, true);
  const w = report.data.purge.willDelete;
  assert.equal(w.customers, 1);
  assert.equal(w.orders, 2);
  assert.equal(w.checkins, 2);
  assert.equal(w.payments, 1);
  assert.equal(w.payments_amount_amd, 25000);
  assert.equal(w.cash_handoffs, 1);
  assert.equal(w.cash_expenses, 1);
  assert.equal(w.perf_plans, 1);
  assert.equal(w.delivery_routes, 1);
  assert.equal(report.data.purge.willKeep.customers_with_erp_id_handed_to_you, 1);
  assert.equal(report.data.purge.willKeep.customers_only_assigned_unassigned, 2);

  const done = await apiRequest(`/api/users/${tester.id}/purge`, { method: "POST", cookie: adminCookie, body: { confirm: true } });
  assert.equal(done.status, 200, JSON.stringify(done.data));

  assert.equal(await count("SELECT count(*)::int AS n FROM users WHERE id = $1", [tester.id]), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM customers WHERE id = $1", [testCust.id]), 0, "test customer deleted");
  assert.equal(await count("SELECT count(*)::int AS n FROM orders WHERE id = ANY($1)", [[testerOrder.data.id, otherOnTest.data.id]]), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM payments WHERE id = $1", [pay.rows[0].id]), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM cash_handoffs WHERE id = $1", [handoff.rows[0].id]), 0);
  assert.equal(await count("SELECT count(*)::int AS n FROM checkins WHERE customer_id = $1", [erpCust.id]), 0);
  // what is real stays
  const keep = (await pool.query("SELECT created_by FROM customers WHERE id = $1", [erpCust.id])).rows[0];
  assert.equal(keep.created_by, admin.id, "ERP customer handed to the admin");
  const assigned = (await pool.query("SELECT assigned_manager_id FROM customers WHERE id = $1", [realCustAssigned.id])).rows[0];
  assert.equal(assigned.assigned_manager_id, null);
  assert.equal(await count("SELECT count(*)::int AS n FROM orders WHERE id = $1", [realOrderRes.data.id]), 1, "someone else's order on a real customer stays");
});
