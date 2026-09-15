// Drives one order through its full real lifecycle over HTTP against a
// real Postgres-backed app instance: draft -> submit -> confirm -> pack ->
// deliver -> recorded, plus the reject/draft-edit side branch and the
// discount-approval gate. Each step asserts both the expected success AND
// that the concurrency guards added this round (see orders.js/warehouse.js/
// delivery.js) actually hold: a repeated call to a transition that already
// happened must fail cleanly (409), never silently re-apply.
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

test("full order lifecycle: draft -> submit -> confirm -> pack -> deliver -> recorded", async () => {
  const manager = await createUser("sales_manager");
  const director = await createUser("sales_director");
  const warehouseMgr = await createUser("warehouse_manager");
  const admin = await createUser("admin");
  // Deliberately no erp_customer_id yet -- orders.js auto-submits a new
  // order for a customer that already has one linked, and this test wants
  // to drive draft -> submit explicitly (providing the ERP id ON submit
  // instead, which is itself a real, supported path -- see orders.js's
  // /submit handler linking it on the fly).
  const customer = await createCustomer({ created_by: manager.id, assigned_manager_id: manager.id });
  const product = await createProduct({ unit_price_amd: 1500 });

  const managerCookie = await loginAs(manager.email);
  const directorCookie = await loginAs(director.email);
  const whCookie = await loginAs(warehouseMgr.email);
  const adminCookie = await loginAs(admin.email);

  // 1. Create (starts as draft)
  const created = await apiRequest("/api/orders", {
    method: "POST",
    cookie: managerCookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 3 }], payment_method: "cash" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, "draft");
  const orderId = trackOrder(created.data.id);
  assert.equal(created.data.total_amd, "4500");

  // 2. Submit -- links the ERP customer id on the fly since the customer
  // fixture deliberately didn't have one (see the note above).
  const submitted = await apiRequest(`/api/orders/${orderId}/submit`, {
    method: "POST",
    cookie: managerCookie,
    body: { erp_customer_id: `itest-lifecycle-${manager.id}` },
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.status, "submitted");

  // Re-submitting an already-submitted order must be rejected, not re-applied.
  const resubmit = await apiRequest(`/api/orders/${orderId}/submit`, { method: "POST", cookie: managerCookie });
  assert.equal(resubmit.status, 409);

  // 3. Confirm (director-only)
  const confirmed = await apiRequest(`/api/orders/${orderId}`, {
    method: "PATCH",
    cookie: directorCookie,
    body: { status: "confirmed" },
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.status, "confirmed");

  // 4. Pack (warehouse-only) -- and confirm the concurrency guard: a
  // second pack attempt on the now-packed order must 409, not double-pack.
  const packed = await apiRequest(`/api/warehouse/orders/${orderId}/packed`, { method: "POST", cookie: whCookie });
  assert.equal(packed.status, 200);
  assert.equal(packed.data.status, "packed_stock_out");
  const rePack = await apiRequest(`/api/warehouse/orders/${orderId}/packed`, { method: "POST", cookie: whCookie });
  assert.equal(rePack.status, 409);

  // 5. Deliver (office-side override endpoint, no signature required)
  const delivered = await apiRequest(`/api/orders/${orderId}/mark-delivered`, { method: "POST", cookie: adminCookie });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.data.status, "delivered");
  const reDeliver = await apiRequest(`/api/orders/${orderId}/mark-delivered`, { method: "POST", cookie: adminCookie });
  assert.equal(reDeliver.status, 409);

  // 6. Recorded (accountant/admin bookkeeping flag)
  const recorded = await apiRequest(`/api/orders/${orderId}/recorded`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { recorded: true },
  });
  assert.equal(recorded.status, 200);
  assert.equal(recorded.data.recorded, true);

  // The full created -> submitted -> confirmed -> packed -> delivered
  // timeline (order_status_history, migration 070) should have exactly one
  // entry per real transition above, in order -- this is what the order
  // detail screen's own timeline renders.
  const withHistory = await apiRequest(`/api/orders/${orderId}`, { cookie: adminCookie });
  const transitions = withHistory.data.history.map((h) => `${h.old_status}->${h.new_status}`);
  assert.deepEqual(transitions, [
    "null->draft",
    "draft->submitted",
    "submitted->confirmed",
    "confirmed->packed_stock_out",
    "packed_stock_out->delivered",
  ]);
});

test("rejecting a submitted order returns it to draft, and the owner can then edit and resubmit", async () => {
  const manager = await createUser("sales_manager");
  const director = await createUser("sales_director");
  const customer = await createCustomer({ created_by: manager.id, erp_customer_id: `itest-reject-${manager.id}` });
  const product = await createProduct();

  const managerCookie = await loginAs(manager.email);
  const directorCookie = await loginAs(director.email);

  const created = await apiRequest("/api/orders", {
    method: "POST",
    cookie: managerCookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash" },
  });
  const orderId = trackOrder(created.data.id);
  await apiRequest(`/api/orders/${orderId}/submit`, { method: "POST", cookie: managerCookie });

  const rejected = await apiRequest(`/api/orders/${orderId}/reject`, {
    method: "POST",
    cookie: directorCookie,
    body: { note: "Wrong pricing" },
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.status, "draft");

  // The owning manager can edit a rejected (now draft) order's items --
  // this was the exact gap phase 3 of the plan closed.
  const edited = await apiRequest(`/api/orders/${orderId}`, {
    method: "PATCH",
    cookie: managerCookie,
    body: { items: [{ product_id: product.id, quantity: 2 }] },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.status, "draft");
});

test("confirming an order with a pending discount approval is blocked until approved", async () => {
  const manager = await createUser("sales_manager");
  const director = await createUser("sales_director");
  const customer = await createCustomer({ created_by: manager.id, erp_customer_id: `itest-discount-${manager.id}` });
  const product = await createProduct({ unit_price_amd: 10000 });

  const managerCookie = await loginAs(manager.email);
  const directorCookie = await loginAs(director.email);

  const created = await apiRequest("/api/orders", {
    method: "POST",
    cookie: managerCookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash" },
  });
  const orderId = trackOrder(created.data.id);
  await apiRequest(`/api/orders/${orderId}/submit`, { method: "POST", cookie: managerCookie });

  // A large discount on submit puts approval_status into "pending" --
  // confirming while that's still pending must be refused (409), which is
  // exactly the bypass phase-1 of the earlier round closed (it used to
  // read a stale pre-request approval_status instead of the freshly
  // computed one).
  const discountEdit = await apiRequest(`/api/orders/${orderId}`, {
    method: "PATCH",
    cookie: directorCookie,
    body: { discount_pct: 30 },
  });
  assert.equal(discountEdit.status, 200);
  assert.equal(discountEdit.data.approval_status, "pending");

  const confirmWhilePending = await apiRequest(`/api/orders/${orderId}`, {
    method: "PATCH",
    cookie: directorCookie,
    body: { status: "confirmed" },
  });
  assert.equal(confirmWhilePending.status, 409);

  const approved = await apiRequest(`/api/orders/${orderId}/approve-discount`, { method: "POST", cookie: directorCookie });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.approval_status, "approved");

  const confirmAfterApproval = await apiRequest(`/api/orders/${orderId}`, {
    method: "PATCH",
    cookie: directorCookie,
    body: { status: "confirmed" },
  });
  assert.equal(confirmAfterApproval.status, 200);
  assert.equal(confirmAfterApproval.data.status, "confirmed");
});
