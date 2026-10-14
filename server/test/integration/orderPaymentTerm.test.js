// The new order sheet's "Payment due: N days" (Invoice orders): stored on the order, validated, cash has none.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";

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
  const cash = await post({ payment_method: "cash", payment_term_days: 21 });
  trackOrder(cash.data.id);
  assert.equal(cash.data.payment_term_days, null, "cash is paid at once");
  const none = await post({ payment_method: "invoice" });
  trackOrder(none.data.id);
  assert.equal(none.data.payment_term_days, null);
  for (const bad of [0, 400, 2.5, "abc"]) assert.equal((await post({ payment_method: "invoice", payment_term_days: bad })).status, 400, `payment_term_days ${bad}`);
});
