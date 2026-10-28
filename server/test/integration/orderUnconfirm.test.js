// Back to submitted (owner, 2026-10-28): a director moves a CONFIRMED order back to submitted to change it, then confirms it again.
// Refused for a rep or the accountant, for a packed order, and while accounting works on its documents; a pending accounting request
// is cancelled so Lily does not pick it up.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let rep, repCookie, directorCookie, accountantCookie, customer, product;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  const director = await createUser("sales_director");
  const accountant = await createUser("accountant");
  repCookie = await loginAs(rep.email);
  directorCookie = await loginAs(director.email);
  accountantCookie = await loginAs(accountant.email);
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `UC-${Date.now()}` });
  product = await createProduct({ unit: "4L" });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const confirmedOrder = async () => {
  const res = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, payment_method: "invoice", items: [{ product_id: product.id, quantity: 1 }] } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackOrder(res.data.id);
  assert.equal((await apiRequest(`/api/orders/${res.data.id}`, { method: "PATCH", cookie: directorCookie, body: { status: "confirmed" } })).status, 200);
  return res.data.id;
};
const unconfirm = (id, cookie) => apiRequest(`/api/orders/${id}/unconfirm`, { method: "POST", cookie, body: {} });

test("a director moves a confirmed order back to submitted, edits it and confirms it again", async () => {
  const id = await confirmedOrder();
  assert.equal((await unconfirm(id, repCookie)).status, 403);
  assert.equal((await unconfirm(id, accountantCookie)).status, 403);
  const back = await unconfirm(id, directorCookie);
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.status, "submitted");
  const detail = await apiRequest(`/api/orders/${id}`, { cookie: directorCookie });
  assert.ok(detail.data.history.some((h) => h.old_status === "confirmed" && h.new_status === "submitted"));
  // now editable by the director, then confirmed again
  const edited = await apiRequest(`/api/orders/${id}`, { method: "PATCH", cookie: directorCookie, body: { items: [{ product_id: product.id, quantity: 3 }] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal((await apiRequest(`/api/orders/${id}`, { method: "PATCH", cookie: directorCookie, body: { status: "confirmed" } })).status, 200);
  assert.equal((await unconfirm(id, directorCookie)).status, 200, "and back again");
  assert.equal((await unconfirm(id, directorCookie)).status, 409, "a submitted order is not confirmed");
});

test("accounting: a pending request is cancelled; documents in progress block it; a packed order cannot go back", async () => {
  const pendingId = await confirmedOrder();
  await pool.query("UPDATE orders SET accounting_status = 'pending' WHERE id = $1", [pendingId]);
  const back = await unconfirm(pendingId, directorCookie);
  assert.equal(back.status, 200);
  assert.equal(back.data.accounting_status, "cancelled");

  const busyId = await confirmedOrder();
  await pool.query("UPDATE orders SET accounting_status = 'waybill_created' WHERE id = $1", [busyId]);
  const busy = await unconfirm(busyId, directorCookie);
  assert.equal(busy.status, 409);
  assert.equal(busy.data.code, "accounting_busy");

  const packedId = await confirmedOrder();
  await pool.query("UPDATE orders SET status = 'packed_stock_out' WHERE id = $1", [packedId]);
  assert.equal((await unconfirm(packedId, directorCookie)).status, 409);
});
