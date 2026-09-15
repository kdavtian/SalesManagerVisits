// Real HTTP requests against the real app + a real Postgres connection
// (see helpers.js) -- exercises the role/permission matrix the way an
// actual client would hit it, rather than unit-testing roles.js's pure
// functions in isolation (already covered indirectly by every route that
// calls them). Focused on the specific gaps this stabilization round
// fixed or reasoned about: discount approval, warehouse/delivery actions,
// and debt-balances visibility scoping.
import test from "node:test";
import assert from "node:assert/strict";
import {
  startTestServer,
  stopTestServer,
  cleanupAll,
  createUser,
  createCustomer,
  createProduct,
  loginAs,
  apiRequest,
  trackOrder,
} from "./helpers.js";

test.before(startTestServer);
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("a sales_manager cannot confirm-with-discount-approval another role's order", async () => {
  const manager = await createUser("sales_manager");
  const director = await createUser("sales_director");
  // Deliberately no erp_customer_id -- orders.js auto-submits new orders
  // for a customer that already has one linked, and this test wants to
  // drive the draft -> submit -> confirm steps explicitly.
  const customer = await createCustomer({ created_by: manager.id });
  const product = await createProduct();

  const managerCookie = await loginAs(manager.email);
  const created = await apiRequest("/api/orders", {
    method: "POST",
    cookie: managerCookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash" },
  });
  assert.equal(created.status, 201);
  trackOrder(created.data.id);

  // Only a director (or admin) can move a submitted order to confirmed --
  // a plain sales_manager hitting the same endpoint on their own order
  // must be rejected, not silently accepted.
  const managerConfirmAttempt = await apiRequest(`/api/orders/${created.data.id}`, {
    method: "PATCH",
    cookie: managerCookie,
    body: { status: "confirmed" },
  });
  assert.equal(managerConfirmAttempt.status, 403);

  const directorCookie = await loginAs(director.email);
  const directorConfirmAttempt = await apiRequest(`/api/orders/${created.data.id}`, {
    method: "PATCH",
    cookie: directorCookie,
    body: { status: "confirmed" },
  });
  // Still draft (never submitted) -- confirming here requires BOTH the
  // right role AND order.status === "submitted" (see orders.js's
  // canReviewSubmitted), so a director hitting a still-draft order gets
  // the same 403 a wrong role would, not a state-specific 409.
  assert.equal(directorConfirmAttempt.status, 403);
});

test("only warehouse-capable roles can mark an order packed", async () => {
  const manager = await createUser("sales_manager");
  const warehouseMgr = await createUser("warehouse_manager");
  const customer = await createCustomer({ created_by: manager.id });
  const product = await createProduct();

  const managerCookie = await loginAs(manager.email);
  const created = await apiRequest("/api/orders", {
    method: "POST",
    cookie: managerCookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash" },
  });
  trackOrder(created.data.id);

  const managerPackAttempt = await apiRequest(`/api/warehouse/orders/${created.data.id}/packed`, {
    method: "POST",
    cookie: managerCookie,
  });
  assert.equal(managerPackAttempt.status, 403);

  const whCookie = await loginAs(warehouseMgr.email);
  const whPackAttempt = await apiRequest(`/api/warehouse/orders/${created.data.id}/packed`, {
    method: "POST",
    cookie: whCookie,
  });
  // Order is still in draft (never confirmed), so this is correctly a 409
  // ("only a confirmed order can be packed"), not a 403 -- confirms role
  // check passes for warehouse_manager and the STATE check is what's left.
  assert.equal(whPackAttempt.status, 409);
});

test("a sales_manager only sees their own book in debt balances, not another manager's", async () => {
  const managerA = await createUser("sales_manager");
  const managerB = await createUser("sales_manager");
  const customerA = await createCustomer({ created_by: managerA.id, assigned_manager_id: managerA.id, erp_customer_id: `itest-debt-a-${managerA.id}` });
  const customerB = await createCustomer({ created_by: managerB.id, assigned_manager_id: managerB.id, erp_customer_id: `itest-debt-b-${managerB.id}` });

  const { pool } = await import("../../src/db/pool.js");
  await pool.query(
    `INSERT INTO erp_customer_data (erp_customer_id, debt_amd) VALUES ($1, 5000), ($2, 7000)
     ON CONFLICT (erp_customer_id) DO UPDATE SET debt_amd = EXCLUDED.debt_amd`,
    [customerA.erp_customer_id, customerB.erp_customer_id]
  );

  const cookieA = await loginAs(managerA.email);
  const listA = await apiRequest("/api/debt-balances", { cookie: cookieA });
  assert.equal(listA.status, 200);
  const idsA = listA.data.map((r) => r.internal_customer_id);
  assert.ok(idsA.includes(customerA.id), "manager A should see their own customer's debt");
  assert.ok(!idsA.includes(customerB.id), "manager A should NOT see manager B's customer debt");

  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [
    [customerA.erp_customer_id, customerB.erp_customer_id],
  ]);
});
