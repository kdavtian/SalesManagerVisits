// A notification about one order must carry a link that opens THAT order (owner, 2026-10-18).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

test.before(startTestServer);
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const waitFor = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
};

test("order placed / status changed notifications link to the order, not the list", async () => {
  const manager = await createUser("sales_manager");
  const director = await createUser("sales_director");
  const customer = await createCustomer({ created_by: manager.id, assigned_manager_id: manager.id, erp_customer_id: `itest-nl-${manager.id}` });
  const product = await createProduct({ unit_price_amd: 1500 });
  const managerCookie = await loginAs(manager.email);
  const directorCookie = await loginAs(director.email);

  const created = await apiRequest("/api/orders", { method: "POST", cookie: managerCookie, body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 2 }], payment_method: "cash" } });
  assert.equal(created.status, 201);
  const orderId = trackOrder(created.data.id);

  // Every sales director is notified about EVERY order placed, including the ones other test files place at the same moment: look for this
  // order's own notification instead of "the newest one".
  const url = `/#/orders?open=${orderId}`;
  const placed = await waitFor(async () => (await pool.query("SELECT url FROM notifications WHERE user_id = $1 AND type = 'order_placed' AND url = $2 LIMIT 1", [director.id, url])).rows[0]);
  assert.equal(placed?.url, url);

  const rejected = await apiRequest(`/api/orders/${orderId}`, { method: "PATCH", cookie: directorCookie, body: { status: "confirmed" } });
  assert.equal(rejected.status, 200);
  const changed = await waitFor(async () => (await pool.query("SELECT url FROM notifications WHERE user_id = $1 AND type = 'order_status_changed' AND url = $2 LIMIT 1", [manager.id, url])).rows[0]);
  assert.equal(changed?.url, url);
});
