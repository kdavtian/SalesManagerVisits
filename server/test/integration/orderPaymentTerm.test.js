// The new order sheet's "Payment due: N days" (Invoice orders): stored on the order, validated, cash has none.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let rep, cookie, customer, product;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  cookie = await loginAs(rep.email);
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `PT-${Date.now()}` });
  product = await createProduct({ unit: "4L" });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const post = (extra) => apiRequest("/api/orders", { method: "POST", cookie, body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 2 }], ...extra } });

test("invoice order stores payment_term_days; cash order stores none; bad values are refused", async () => {
  const inv = await post({ payment_method: "invoice", payment_term_days: 21 });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  trackOrder(inv.data.id);
  assert.equal(inv.data.payment_term_days, 21);
  const cash = await post({ payment_method: "cash", payment_term_days: 7 });
  trackOrder(cash.data.id);
  assert.equal(cash.data.payment_term_days, 7, "cash orders carry a due date too (1.334.0)");
  const cashNow = await post({ payment_method: "cash", payment_term_days: 0 });
  trackOrder(cashNow.data.id);
  assert.equal(cashNow.data.payment_term_days, 0, "cash 0 = pay on delivery");
  const none = await post({ payment_method: "invoice" });
  trackOrder(none.data.id);
  assert.equal(none.data.payment_term_days, null);
  for (const bad of [0, 400, 2.5, "abc"]) assert.equal((await post({ payment_method: "invoice", payment_term_days: bad })).status, 400, `payment_term_days ${bad}`);
  assert.equal((await post({ payment_method: "cash", payment_term_days: -1 })).status, 400);
  assert.equal((await post({ payment_method: "cash", payment_term_days: 366 })).status, 400);
});

test("downpayment: % is computed on the total after discount, AMD is kept, too much is refused, none stays null", async () => {
  // product price x 2 = subtotal; 10 % discount first, then 30 % down on what is left
  const pct = await post({ payment_method: "invoice", payment_term_days: 30, discount_pct: 10, downpayment_pct: 30 });
  assert.equal(pct.status, 201, JSON.stringify(pct.data));
  trackOrder(pct.data.id);
  const total = Number(pct.data.total_amd);
  assert.ok(total > 0);
  assert.equal(Number(pct.data.downpayment_pct), 30);
  assert.equal(Number(pct.data.downpayment_amd), Math.round(total * 0.3));

  const amd = await post({ payment_method: "cash", payment_term_days: 0, downpayment_amd: 1000 });
  assert.equal(amd.status, 201, JSON.stringify(amd.data));
  trackOrder(amd.data.id);
  assert.equal(Number(amd.data.downpayment_amd), 1000);
  assert.ok(Number(amd.data.downpayment_pct) > 0);

  const zero = await post({ payment_method: "invoice", downpayment_pct: 0 });
  trackOrder(zero.data.id);
  assert.equal(Number(zero.data.downpayment_amd), 0, "the rep chose no downpayment");

  const unset = await post({ payment_method: "invoice" });
  trackOrder(unset.data.id);
  assert.equal(unset.data.downpayment_amd, null);
  assert.equal(unset.data.downpayment_pct, null);

  assert.equal((await post({ payment_method: "invoice", downpayment_pct: 101 })).status, 400);
  assert.equal((await post({ payment_method: "invoice", downpayment_pct: -1 })).status, 400);
  assert.equal((await post({ payment_method: "invoice", downpayment_amd: -5 })).status, 400);
  assert.equal((await post({ payment_method: "invoice", downpayment_amd: total * 100 })).status, 400, "more than the whole order");
});

test("order-defaults: 30 % on a customer's first order, 15 % once they have one; the credit term comes along", async () => {
  const fresh = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `PTD-${Date.now()}` });
  await pool.query("UPDATE customers SET credit_term_days = 21 WHERE id = $1", [fresh.id]);
  const first = await apiRequest(`/api/customers/${fresh.id}/order-defaults`, { cookie });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual({ first_order: first.data.first_order, downpayment_pct: first.data.downpayment_pct, credit_term_days: first.data.credit_term_days }, { first_order: true, downpayment_pct: 30, credit_term_days: 21 });
  const made = await apiRequest("/api/orders", { method: "POST", cookie, body: { customer_id: fresh.id, payment_method: "invoice", items: [{ product_id: product.id, quantity: 1 }] } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  trackOrder(made.data.id);
  const next = await apiRequest(`/api/customers/${fresh.id}/order-defaults`, { cookie });
  assert.equal(next.data.first_order, false);
  assert.equal(next.data.downpayment_pct, 15);
  assert.equal((await apiRequest("/api/customers/99999999/order-defaults", { cookie })).status, 404);
});

test("editing an order's lines keeps its downpayment percentage", async () => {
  const made = await post({ payment_method: "invoice", downpayment_pct: 20 });
  trackOrder(made.data.id);
  const edited = await apiRequest(`/api/orders/${made.data.id}`, { method: "PATCH", cookie, body: { items: [{ product_id: product.id, quantity: 6 }] } });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(Number(edited.data.downpayment_pct), 20);
  assert.equal(Number(edited.data.downpayment_amd), Math.round(Number(edited.data.total_amd) * 0.2));
});
