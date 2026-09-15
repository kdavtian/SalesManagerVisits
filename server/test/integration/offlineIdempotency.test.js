// Covers the server side of "prevent duplicate visits/orders after
// connection recovery" and "bind queued records to their creator" (phase 2
// of the stabilization plan) -- offlineQueue.js's own client-side retry
// logic is covered by the client-side Playwright verification done for
// those PRs; this is the part a browser-only test can't reach: hitting the
// real create endpoints twice with the same client_ref, and confirming the
// server never trusts a client-supplied user id.
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

test("creating an order twice with the same client_ref returns the same order, not a duplicate", async () => {
  const manager = await createUser("sales_manager");
  const customer = await createCustomer({ created_by: manager.id });
  const product = await createProduct();
  const cookie = await loginAs(manager.email);
  const clientRef = `itest-order-ref-${Date.now()}`;

  const first = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash", client_ref: clientRef },
  });
  assert.equal(first.status, 201);
  trackOrder(first.data.id);

  // Simulates the offline queue retrying the same queued submission after
  // reconnecting -- must not create a second order.
  const second = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash", client_ref: clientRef },
  });
  assert.equal(second.status, 201);
  assert.equal(second.data.id, first.data.id, "retrying with the same client_ref must return the SAME order, not create a new one");

  const { pool } = await import("../../src/db/pool.js");
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM orders WHERE client_ref = $1", [clientRef]);
  assert.equal(rows[0].n, 1);
});

test("creating a checkin twice with the same client_ref returns the same checkin, not a duplicate", async () => {
  const manager = await createUser("sales_manager");
  const customer = await createCustomer({ created_by: manager.id });
  const cookie = await loginAs(manager.email);
  const clientRef = `itest-checkin-ref-${Date.now()}`;

  const form = new FormData();
  form.set("customer_id", String(customer.id));
  form.set("lat", "40.18");
  form.set("lng", "44.51");
  form.set("outcomes", JSON.stringify(["no_order"]));
  form.set("client_ref", clientRef);

  const { pool } = await import("../../src/db/pool.js");
  const port = new URL((await startTestServer())).port;
  // Multipart checkin submission bypasses apiRequest() (which auto-attaches
  // this from `cookie`), so the CSRF double-submit header is pulled out
  // and attached here by hand, same as apiRequest() does internally.
  const csrfToken = cookie.match(/(?:^|; )csrf_token=([^;]+)/)?.[1];
  const csrfHeaders = { Cookie: cookie, ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) };
  const first = await fetch(`http://127.0.0.1:${port}/api/checkins`, { method: "POST", headers: csrfHeaders, body: form });
  const firstData = await first.json();
  assert.equal(first.status, 201);

  const second = await fetch(`http://127.0.0.1:${port}/api/checkins`, { method: "POST", headers: csrfHeaders, body: form });
  const secondData = await second.json();
  assert.equal(second.status, 201);
  assert.equal(secondData.id, firstData.id, "retrying with the same client_ref must return the SAME checkin, not create a new one");

  const { rows } = await pool.query("SELECT count(*)::int AS n FROM checkins WHERE client_ref = $1", [clientRef]);
  assert.equal(rows[0].n, 1);
  await pool.query("DELETE FROM checkins WHERE id = $1", [firstData.id]);
});

test("a created order is always bound to the authenticated requester, never a client-supplied user id", async () => {
  const manager = await createUser("sales_manager");
  const otherUser = await createUser("sales_manager");
  const customer = await createCustomer({ created_by: manager.id });
  const product = await createProduct();
  const cookie = await loginAs(manager.email);

  // Attempt to spoof authorship by sending a foreign user_id in the body --
  // the endpoint doesn't even accept this field, but this proves the
  // resulting row is bound to the SESSION regardless of anything the
  // client sends.
  const created = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: {
      customer_id: customer.id,
      items: [{ product_id: product.id, quantity: 1 }],
      payment_method: "cash",
      user_id: otherUser.id,
    },
  });
  assert.equal(created.status, 201);
  trackOrder(created.data.id);
  assert.equal(created.data.user_id, manager.id, "order must be bound to the logged-in user, not the spoofed user_id");
});
