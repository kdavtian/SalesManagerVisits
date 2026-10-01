// API coverage for Warehouse and delivery (server/src/routes/warehouse.js,
// server/src/routes/delivery.js): role gating (canManageWarehouse /
// canPlanRoutes / canDeliverOrders -- all satisfied by delivery_manager or
// admin), state-mismatch 409s on packing/stock-issue/confirm, missing
// signature upload as boundary input, route planning succeeding with OSRM
// unreachable (falls back to haversine -- "missing external service"), and
// unauthenticated access.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, apiFormRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let users;
let cookies;
let customer;
let product;

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "sales_manager", "delivery_manager", "ceo"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
  customer = await createCustomer({ created_by: users.sales_manager.id });
  product = await createProduct();
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

async function createOrder(status) {
  const { rows } = await pool.query(
    `INSERT INTO orders (customer_id, user_id, status, total_amd, discount_pct, discount_amd, approval_status, order_code, payment_method)
     VALUES ($1, $2, $3, 1000, 0, 0, 'not_required', $4, 'cash') RETURNING id`,
    [customer.id, users.sales_manager.id, status, `ITEST-WD-${Date.now()}-${Math.random().toString(36).slice(2)}`]
  );
  trackOrder(rows[0].id);
  await pool.query(
    "INSERT INTO order_items (order_id, product_id, product_name, brand, unit_price_amd, quantity, line_total_amd) VALUES ($1, $2, $3, $4, $5, 1, $5)",
    [rows[0].id, product.id, product.name, product.brand ?? null, product.unit_price_amd]
  );
  return rows[0].id;
}

// --- Warehouse: role gating + valid pack ------------------------------------------

test("POST /api/warehouse/orders/:id/packed: a sales_manager (not canManageWarehouse) gets 403; an admin can pack a confirmed order", async () => {
  const orderId = await createOrder("confirmed");
  const denied = await apiRequest(`/api/warehouse/orders/${orderId}/packed`, { method: "POST", cookie: cookies.sales_manager });
  assert.equal(denied.status, 403);

  const allowed = await apiRequest(`/api/warehouse/orders/${orderId}/packed`, { method: "POST", cookie: cookies.admin });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.status, "packed_stock_out");
});

test("POST /api/warehouse/orders/:id/packed: an order not in 'confirmed' status is a 409", async () => {
  const orderId = await createOrder("draft");
  const res = await apiRequest(`/api/warehouse/orders/${orderId}/packed`, { method: "POST", cookie: cookies.admin });
  assert.equal(res.status, 409);
});

test("POST /api/warehouse/orders/:id/packed: a nonexistent order is a 404", async () => {
  const res = await apiRequest("/api/warehouse/orders/999999999/packed", { method: "POST", cookie: cookies.admin });
  assert.equal(res.status, 404);
});

test("POST /api/warehouse/orders/:id/stock-issue: a missing note is a 400; a valid note drops the order back to draft", async () => {
  const orderId = await createOrder("confirmed");

  const missing = await apiRequest(`/api/warehouse/orders/${orderId}/stock-issue`, { method: "POST", cookie: cookies.admin, body: {} });
  assert.equal(missing.status, 400);

  const valid = await apiRequest(`/api/warehouse/orders/${orderId}/stock-issue`, { method: "POST", cookie: cookies.admin, body: { note: "Out of stock" } });
  assert.equal(valid.status, 200);
  assert.equal(valid.data.status, "draft");
});

test("Warehouse endpoints reject an unauthenticated request with 401", async () => {
  const res = await apiRequest("/api/warehouse/pick-list");
  assert.equal(res.status, 401);
});

// Regression: canManageWarehouse previously didn't include ceo at all, so
// a CEO account got 403 from every warehouse endpoint despite already
// being one of STOCK_ISSUE_NOTIFY_ROLES (notificationPreferences.js) --
// notified about stock issues on a screen they couldn't open.
test("GET /api/warehouse/pick-list and /inventory: a ceo can access warehouse screens like sales_director/admin", async () => {
  const pickList = await apiRequest("/api/warehouse/pick-list", { cookie: cookies.ceo });
  assert.equal(pickList.status, 200);
  const inventory = await apiRequest("/api/warehouse/inventory", { cookie: cookies.ceo });
  assert.equal(inventory.status, 200);
});

// Regression: the Inventory screen's landing/net cost toggle cycles a
// single button through both figures (see views/warehouse.js), but the
// endpoint only ever returned landing_cost_amd -- net_cost_amd was
// missing from the SELECT entirely, so the "net" state had no data to show.
test("GET /api/warehouse/inventory: includes net_cost_amd alongside landing_cost_amd", async () => {
  await pool.query("UPDATE products SET landing_cost_amd = 700, net_cost_amd = 900 WHERE id = $1", [product.id]);
  const res = await apiRequest("/api/warehouse/inventory", { cookie: cookies.ceo });
  assert.equal(res.status, 200);
  const row = res.data.find((p) => p.id === product.id);
  assert.ok(row, "the test fixture product must appear in the inventory list");
  assert.equal(Number(row.landing_cost_amd), 700);
  assert.equal(Number(row.net_cost_amd), 900);
});

// The "days of stock left" estimate (stockForecast.js) is unit-tested on
// its own against fixed inputs; this covers the wiring -- that the
// endpoint actually pulls real sales history from erp_order_lines (joined
// on erp_product_id, not the in-app product_id) and attaches a sane
// forecast to the row, and that the `stock`/`size` filters work end to end.
test("GET /api/warehouse/inventory: attaches a stock forecast from erp_order_lines sales history, and the stock/size filters work", async () => {
  const forecastProduct = await createProduct({ name: "Forecast Test Oil", unit: "1L" });
  const erpId = `FCTEST-${forecastProduct.id}`;
  await pool.query("UPDATE products SET erp_product_id = $1, stock_qty = 5 WHERE id = $2", [erpId, forecastProduct.id]);
  // 1 unit/day over the last 30 days (30 units) and the same steady rate
  // over 90 (90 units) -- no trend, blended demand should land at 1/day,
  // so 5 units on hand is well inside the "critical" band (<7 days).
  const rows = [];
  for (let i = 0; i < 90; i++) {
    rows.push(`('${erpId}', 'ORD-${forecastProduct.id}-${i}', CURRENT_DATE - ${i}, '${erpId}', 1)`);
  }
  await pool.query(`INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, qty) VALUES ${rows.join(",")}`);

  try {
    const res = await apiRequest("/api/warehouse/inventory", { cookie: cookies.ceo });
    assert.equal(res.status, 200);
    const row = res.data.find((p) => p.id === forecastProduct.id);
    assert.ok(row, "the forecast test product must appear in the inventory list");
    assert.equal(row.stock_status, "critical");
    assert.ok(Number(row.daily_demand) > 0.9 && Number(row.daily_demand) < 1.1);
    assert.ok(Number(row.days_of_stock) < 7);

    const lowStockRes = await apiRequest("/api/warehouse/inventory?stock=low_stock", { cookie: cookies.ceo });
    assert.ok(lowStockRes.data.some((p) => p.id === forecastProduct.id), "low_stock filter must include a critical-status row");
    assert.ok(
      lowStockRes.data.every((p) => p.stock_status === "critical" || p.stock_status === "low"),
      "low_stock filter must only return critical/low rows"
    );

    // Matched case/whitespace-insensitively (e.g. "1l" and "1 L" are the
    // same size), not by exact string -- see the `size` filter's own
    // comment in routes/warehouse.js.
    const normalize = (u) => String(u).trim().replace(/\s+/g, "").toLowerCase();
    const sizeRes = await apiRequest("/api/warehouse/inventory?size=1L", { cookie: cookies.ceo });
    assert.ok(sizeRes.data.every((p) => normalize(p.unit) === "1l"), "size filter must only return matching-unit rows");
    assert.ok(sizeRes.data.some((p) => p.id === forecastProduct.id));
  } finally {
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erpId]);
  }
});

// Regression: the ERP-sourced unit column has real spelling drift ("1l"
// vs "1L" vs "1 L" for what's the same physical size), which initially
// meant /inventory/sizes listed near-duplicate options that all display
// as the same normalized label, and the `size` filter missed products
// spelled differently than whichever option the WM happened to tap.
test("GET /api/warehouse/inventory and /inventory/sizes: size matching is case/whitespace-insensitive", async () => {
  const lower = await createProduct({ name: "Spelling Drift Oil A", unit: "2l" });
  const upper = await createProduct({ name: "Spelling Drift Oil B", unit: "2L" });
  const spaced = await createProduct({ name: "Spelling Drift Oil C", unit: "2 L" });

  const sizesRes = await apiRequest("/api/warehouse/inventory/sizes", { cookie: cookies.ceo });
  const normalize = (u) => String(u).trim().replace(/\s+/g, "").toLowerCase();
  const twoLiterOptions = sizesRes.data.filter((u) => normalize(u) === "2l");
  assert.equal(twoLiterOptions.length, 1, "the three spellings of 2L must collapse into one filter option");

  const filteredRes = await apiRequest(`/api/warehouse/inventory?size=${encodeURIComponent(twoLiterOptions[0])}`, { cookie: cookies.ceo });
  const ids = filteredRes.data.map((p) => p.id);
  assert.ok(ids.includes(lower.id) && ids.includes(upper.id) && ids.includes(spaced.id), "all three spellings must match the one filter option");
});

test("GET /api/warehouse/inventory/sizes: returns distinct active product units", async () => {
  const res = await apiRequest("/api/warehouse/inventory/sizes", { cookie: cookies.ceo });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data));
  assert.ok(res.data.includes(product.unit));
});

// --- Delivery: role gating + route planning (OSRM unreachable -> fallback) --------

test("POST /api/delivery/routes/plan: a sales_manager gets 403; a delivery_manager can plan a route, falling back gracefully with OSRM unreachable", async () => {
  const orderId = await createOrder("packed_stock_out");

  const denied = await apiRequest("/api/delivery/routes/plan", { method: "POST", cookie: cookies.sales_manager, body: { driver_id: users.delivery_manager.id } });
  assert.equal(denied.status, 403);

  const planned = await apiRequest("/api/delivery/routes/plan", { method: "POST", cookie: cookies.delivery_manager, body: { driver_id: users.delivery_manager.id } });
  assert.equal(planned.status, 201);
  assert.equal(planned.data.used_osrm, false, "with no OSRM engine reachable in this test environment, planning must still succeed via the haversine fallback");
  assert.ok(planned.data.stops.some((s) => s.order_id === orderId));

  await pool.query("DELETE FROM route_stops WHERE route_id = $1", [planned.data.id]);
  await pool.query("DELETE FROM delivery_routes WHERE id = $1", [planned.data.id]);
});

test("POST /api/delivery/routes/plan: driver_id must belong to a delivery-capable role", async () => {
  await createOrder("packed_stock_out");
  const res = await apiRequest("/api/delivery/routes/plan", { method: "POST", cookie: cookies.delivery_manager, body: { driver_id: users.sales_manager.id } });
  assert.equal(res.status, 400);
});

// --- Delivery confirm: missing signature (boundary), state mismatch ----------------

test("POST /api/delivery/orders/:id/confirm: a missing signature image is a 400", async () => {
  const orderId = await createOrder("packed_stock_out");
  const form = new FormData();
  const res = await apiFormRequest(`/api/delivery/orders/${orderId}/confirm`, { cookie: cookies.delivery_manager, form });
  assert.equal(res.status, 400);
});

test("POST /api/delivery/orders/:id/confirm: an order not in 'packed_stock_out' status is a 409", async () => {
  const orderId = await createOrder("draft");
  const form = new FormData();
  form.append("signature", new Blob([Buffer.from("iVBORw0KGgo=", "base64")], { type: "image/png" }), "sig.png");
  const res = await apiFormRequest(`/api/delivery/orders/${orderId}/confirm`, { cookie: cookies.delivery_manager, form });
  assert.equal(res.status, 409);
});

test("POST /api/delivery/orders/:id/confirm: a valid signature upload delivers the order", async () => {
  const orderId = await createOrder("packed_stock_out");
  const form = new FormData();
  form.append("signature", new Blob([Buffer.from("iVBORw0KGgo=", "base64")], { type: "image/png" }), "sig.png");
  const res = await apiFormRequest(`/api/delivery/orders/${orderId}/confirm`, { cookie: cookies.delivery_manager, form });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, "delivered");

  await pool.query("DELETE FROM pod_records WHERE order_id = $1", [orderId]);
});

test("Delivery endpoints reject an unauthenticated request with 401", async () => {
  const res = await apiRequest("/api/delivery/packed-orders");
  assert.equal(res.status, 401);
});
