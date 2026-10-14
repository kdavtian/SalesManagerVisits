// Management can mark a CONFIRMED order delivered right away (no warehouse "packed" step); other states and roles cannot.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";

let rep, repCookie, director, directorCookie, customer, product;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  director = await createUser("sales_director");
  repCookie = await loginAs(rep.email);
  directorCookie = await loginAs(director.email);
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `DC-${Date.now()}` });
  product = await createProduct({ unit: "4L" });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const newOrder = async () => {
  const res = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, payment_method: "invoice", items: [{ product_id: product.id, quantity: 1 }] } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackOrder(res.data.id);
  return res.data.id;
};

test("confirmed -> delivered in one step, with its own history entry; submitted cannot; a rep cannot", async () => {
  const id = await newOrder();
  assert.equal((await apiRequest(`/api/orders/${id}/mark-delivered`, { method: "POST", cookie: directorCookie })).status, 409, "a submitted order must be confirmed first");
  assert.equal((await apiRequest(`/api/orders/${id}`, { method: "PATCH", cookie: directorCookie, body: { status: "confirmed" } })).status, 200);
  assert.equal((await apiRequest(`/api/orders/${id}/mark-delivered`, { method: "POST", cookie: repCookie })).status, 403);
  const done = await apiRequest(`/api/orders/${id}/mark-delivered`, { method: "POST", cookie: directorCookie });
  assert.equal(done.status, 200);
  assert.equal(done.data.status, "delivered");
  const detail = await apiRequest(`/api/orders/${id}`, { cookie: directorCookie });
  assert.ok(detail.data.history.some((h) => h.old_status === "confirmed" && h.new_status === "delivered"));
  assert.equal((await apiRequest(`/api/orders/${id}/mark-delivered`, { method: "POST", cookie: directorCookie })).status, 409, "already delivered");
});
