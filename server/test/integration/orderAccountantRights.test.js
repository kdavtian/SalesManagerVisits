// The accountant works the order queue: submits a rep's draft, confirms a
// submitted order and sends a confirmed one to accounting (invoice/waybill).
// Directors keep editing, rejecting and discount approval.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { canConfirmSubmittedOrders, canRequestAccountingDocs, canSubmitOrdersForOthers, canConfirmOrders } from "../../src/roles.js";

test.before(startTestServer);
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("role capabilities: accountant joins confirm/accounting/submit but not canConfirmOrders", () => {
  assert.equal(canConfirmSubmittedOrders("accountant"), true);
  assert.equal(canRequestAccountingDocs("accountant"), true);
  assert.equal(canSubmitOrdersForOthers("accountant"), true);
  assert.equal(canConfirmOrders("accountant"), false);
  for (const role of ["sales_manager", "warehouse_manager", "delivery_manager"]) {
    assert.equal(canConfirmSubmittedOrders(role), false, role);
    assert.equal(canRequestAccountingDocs(role), false, role);
    assert.equal(canSubmitOrdersForOthers(role), false, role);
  }
});

test("accountant submits a rep's draft, confirms it and sends it to accounting; cannot reject or edit", async () => {
  const rep = await createUser("sales_manager");
  const director = await createUser("sales_director");
  const accountant = await createUser("accountant");
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, erp_customer_id: `itest-acct-${Date.now()}-${Math.random()}` });
  const product = await createProduct({ unit_price_amd: 3000 });
  const repCookie = await loginAs(rep.email);
  const directorCookie = await loginAs(director.email);
  const accountantCookie = await loginAs(accountant.email);

  const created = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash" } });
  assert.equal(created.status, 201);
  const orderId = trackOrder(created.data.id);

  // The rep cannot confirm their own order; the accountant now can see it in the queue.
  assert.equal((await apiRequest(`/api/orders/${orderId}`, { method: "PATCH", cookie: repCookie, body: { status: "confirmed" } })).status, 403);
  const pending = await apiRequest("/api/orders/pending-count", { cookie: accountantCookie });
  assert.ok(pending.data.count >= 1);

  // Send it back to draft (director rejects), then the accountant submits it again.
  assert.equal((await apiRequest(`/api/orders/${orderId}/reject`, { method: "POST", cookie: directorCookie, body: { note: "check items" } })).status, 200);
  assert.equal((await apiRequest(`/api/orders/${orderId}/reject`, { method: "POST", cookie: accountantCookie, body: {} })).status, 403);
  const otherRep = await createUser("sales_manager");
  assert.equal((await apiRequest(`/api/orders/${orderId}/submit`, { method: "POST", cookie: await loginAs(otherRep.email), body: {} })).status, 403);
  const submitted = await apiRequest(`/api/orders/${orderId}/submit`, { method: "POST", cookie: accountantCookie, body: {} });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.status, "submitted");

  // Accountant may not edit items of a submitted order (director-only) ...
  const edit = await apiRequest(`/api/orders/${orderId}`, { method: "PATCH", cookie: accountantCookie, body: { items: [{ product_id: product.id, quantity: 5 }] } });
  assert.equal(edit.status, 403);
  // ... but confirms it, then asks accounting for the document.
  const confirmed = await apiRequest(`/api/orders/${orderId}`, { method: "PATCH", cookie: accountantCookie, body: { status: "confirmed" } });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.status, "confirmed");
  const request = await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie: accountantCookie, body: {} });
  assert.equal(request.status, 200);
  assert.equal(request.data.accounting_status, "pending");
  assert.equal(request.data.accounting_doc_type, "waybill");

  // Sales manager still cannot send to accounting.
  assert.equal((await apiRequest(`/api/orders/${orderId}/accounting-request`, { method: "POST", cookie: repCookie, body: {} })).status, 403);
});

test("a discounted order still needs the director's approval before the accountant can confirm", async () => {
  const rep = await createUser("sales_manager");
  const director = await createUser("sales_director");
  const accountant = await createUser("accountant");
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, erp_customer_id: `itest-acct2-${Date.now()}-${Math.random()}` });
  const product = await createProduct({ unit_price_amd: 3000 });
  const repCookie = await loginAs(rep.email);
  const accountantCookie = await loginAs(accountant.email);
  const directorCookie = await loginAs(director.email);

  const created = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash", discount_pct: 10 } });
  assert.equal(created.status, 201);
  const orderId = trackOrder(created.data.id);
  assert.equal(created.data.approval_status, "pending");

  const blocked = await apiRequest(`/api/orders/${orderId}`, { method: "PATCH", cookie: accountantCookie, body: { status: "confirmed" } });
  assert.equal(blocked.status, 409);
  assert.equal((await apiRequest(`/api/orders/${orderId}/approve-discount`, { method: "POST", cookie: accountantCookie, body: {} })).status, 403);

  assert.equal((await apiRequest(`/api/orders/${orderId}/approve-discount`, { method: "POST", cookie: directorCookie, body: {} })).status, 200);
  const ok = await apiRequest(`/api/orders/${orderId}`, { method: "PATCH", cookie: accountantCookie, body: { status: "confirmed" } });
  assert.equal(ok.status, 200);
});
