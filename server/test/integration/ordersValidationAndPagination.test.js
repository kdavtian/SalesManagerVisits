// API coverage for Orders and approval lifecycle (server/src/routes/orders.js)
// that isn't already covered by orderLifecycle.test.js (the full draft ->
// delivered happy path + discount-approval gate) or rolePermissions.test.js
// (cross-role confirm/pack denials): invalid/boundary creation input,
// pagination (PAGE_SIZE = 100, has_more/offset), the sales_manager
// own-orders-only filter, and unauthenticated access.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let manager;
let cookie;
let customer;
let product;

test.before(async () => {
  await startTestServer();
  manager = await createUser("sales_manager");
  cookie = await loginAs(manager.email);
  customer = await createCustomer({ created_by: manager.id });
  product = await createProduct();
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

// --- Invalid / boundary input on creation ---------------------------------------

test("POST /api/orders: missing customer_id/items is a 400", async () => {
  const res = await apiRequest("/api/orders", { method: "POST", cookie, body: {} });
  assert.equal(res.status, 400);
});

test("POST /api/orders: an empty items array is a 400", async () => {
  const res = await apiRequest("/api/orders", { method: "POST", cookie, body: { customer_id: customer.id, items: [] } });
  assert.equal(res.status, 400);
});

test("POST /api/orders: an invalid payment_method is a 400", async () => {
  const res = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "bitcoin" },
  });
  assert.equal(res.status, 400);
});

test("POST /api/orders: a non-positive item quantity is a 400", async () => {
  const zero = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 0 }], payment_method: "cash" },
  });
  assert.equal(zero.status, 400);

  const negative = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: -1 }], payment_method: "cash" },
  });
  assert.equal(negative.status, 400);
});

test("POST /api/orders: discount_pct out of [0, 100] is a 400", async () => {
  const over = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash", discount_pct: 101 },
  });
  assert.equal(over.status, 400);

  const negative = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash", discount_pct: -1 },
  });
  assert.equal(negative.status, 400);
});

test("POST /api/orders: a negative discount_amd is a 400", async () => {
  const res = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash", discount_amd: -1 },
  });
  assert.equal(res.status, 400);
});

// --- Pagination (PAGE_SIZE = 100) -------------------------------------------------

test("GET /api/orders: a large result set is paginated at 100 rows with has_more, and offset advances past it", async () => {
  const TOTAL = 105;
  const ids = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < TOTAL; i++) {
      const { rows } = await client.query(
        `INSERT INTO orders (customer_id, user_id, status, total_amd, discount_pct, discount_amd, approval_status, order_code, payment_method)
         VALUES ($1, $2, 'draft', 1000, 0, 0, 'not_required', $3, 'cash') RETURNING id`,
        [customer.id, manager.id, `ITEST-PAGE-${Date.now()}-${i}`]
      );
      ids.push(rows[0].id);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  ids.forEach(trackOrder);

  const firstPage = await apiRequest(`/api/orders?customer_id=${customer.id}`, { cookie });
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.data.rows.length, 100, "a page is capped at PAGE_SIZE (100) rows");
  assert.equal(firstPage.data.has_more, true);

  const secondPage = await apiRequest(`/api/orders?customer_id=${customer.id}&offset=100`, { cookie });
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.data.rows.length, TOTAL - 100, "the remainder must appear on the next page");
  assert.equal(secondPage.data.has_more, false);
});

// --- Own-orders-only filter for a plain sales_manager -----------------------------

test("GET /api/orders: a sales_manager only ever sees their own orders, even when explicitly requesting another user_id", async () => {
  const otherManager = await createUser("sales_manager");
  const otherCustomer = await createCustomer({ created_by: otherManager.id });
  const otherCookie = await loginAs(otherManager.email);

  const created = await apiRequest("/api/orders", {
    method: "POST",
    cookie: otherCookie,
    body: { customer_id: otherCustomer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash" },
  });
  assert.equal(created.status, 201);
  trackOrder(created.data.id);

  // Requesting the other manager's user_id explicitly must still be ignored
  // -- seesAllActivity(role) forces the filter back to the caller's own id.
  const res = await apiRequest(`/api/orders?user_id=${otherManager.id}`, { cookie });
  assert.equal(res.status, 200);
  assert.ok(!res.data.rows.some((o) => o.id === created.data.id), "a sales_manager must never see another manager's order via user_id override");
});

// --- Unauthenticated ---------------------------------------------------------------

test("GET and POST /api/orders reject an unauthenticated request with 401", async () => {
  const getRes = await apiRequest("/api/orders");
  assert.equal(getRes.status, 401);
  const postRes = await apiRequest("/api/orders", { method: "POST", body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }] } });
  assert.equal(postRes.status, 401);
});
