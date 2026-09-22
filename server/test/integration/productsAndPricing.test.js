// API coverage for Products and pricing (server/src/routes/products.js):
// GET is open to every authenticated role; POST/PATCH/DELETE/promos/bulk
// price updates are gated by requireProductManager (canManageProducts:
// admin, ceo, accountant) -- a plain sales_manager is the disallowed-role
// case exercised throughout.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createProduct, apiRequest, loginAs, trackProduct } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let cookies;

test.before(async () => {
  await startTestServer();
  cookies = {};
  for (const role of ["admin", "sales_manager", "accountant"]) {
    const user = await createUser(role);
    cookies[role] = await loginAs(user.email);
  }
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

// --- Valid requests + role enforcement ------------------------------------------

test("GET /api/products: open to every authenticated role, including a plain sales_manager", async () => {
  const res = await apiRequest("/api/products", { cookie: cookies.sales_manager });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data));
});

test("POST /api/products: a product manager (admin) can create a product; a sales_manager gets 403", async () => {
  const denied = await apiRequest("/api/products", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { name: `Itest Denied ${Date.now()}`, unit_price_amd: 500 },
  });
  assert.equal(denied.status, 403);

  const created = await apiRequest("/api/products", {
    method: "POST",
    cookie: cookies.admin,
    body: { name: `Itest Created ${Date.now()}`, unit_price_amd: 500 },
  });
  assert.equal(created.status, 201);
  trackProduct(created.data.id);
  assert.equal(Number(created.data.retail_price_amd), 500, "retail defaults to unit_price_amd when not given");
  assert.equal(created.data.net_cost_amd, null, "net_cost_amd has no default -- unlike retail, there's no sane value to assume");
});

test("POST /api/products: net_cost_amd is optional (admin-entered, no ERP source), and rejects a negative value", async () => {
  const withCost = await apiRequest("/api/products", {
    method: "POST",
    cookie: cookies.admin,
    body: { name: `Itest NetCost ${Date.now()}`, unit_price_amd: 500, net_cost_amd: 300 },
  });
  assert.equal(withCost.status, 201);
  trackProduct(withCost.data.id);
  assert.equal(Number(withCost.data.net_cost_amd), 300);

  const negative = await apiRequest("/api/products", {
    method: "POST",
    cookie: cookies.admin,
    body: { name: "Itest NetCost Negative", unit_price_amd: 500, net_cost_amd: -1 },
  });
  assert.equal(negative.status, 400);
});

// --- Invalid / boundary input -----------------------------------------------------

test("POST /api/products: a missing name is a 400", async () => {
  const res = await apiRequest("/api/products", { method: "POST", cookie: cookies.admin, body: { unit_price_amd: 500 } });
  assert.equal(res.status, 400);
});

test("POST /api/products: a negative unit_price_amd is a 400", async () => {
  const res = await apiRequest("/api/products", { method: "POST", cookie: cookies.admin, body: { name: "Itest Negative", unit_price_amd: -1 } });
  assert.equal(res.status, 400);
});

test("PATCH /api/products/:id: a sales_manager gets 403; accountant (a product manager) can edit and it's logged to price history", async () => {
  const product = await createProduct({ unit_price_amd: 1000 });

  const denied = await apiRequest(`/api/products/${product.id}`, { method: "PATCH", cookie: cookies.sales_manager, body: { bronze_price_amd: 1200 } });
  assert.equal(denied.status, 403);

  const allowed = await apiRequest(`/api/products/${product.id}`, { method: "PATCH", cookie: cookies.accountant, body: { bronze_price_amd: 1200 } });
  assert.equal(allowed.status, 200);
  assert.equal(Number(allowed.data.bronze_price_amd), 1200);

  const { rows } = await pool.query("SELECT * FROM product_price_history WHERE product_id = $1 AND price_type = 'standard'", [product.id]);
  assert.equal(rows.length, 1, "a bronze_price_amd change must be logged as a 'standard' price-history entry");
});

test("PATCH /api/products/:id: net_cost_amd round-trips and is not logged to product_price_history (it's a cost basis, not a price)", async () => {
  const product = await createProduct({ unit_price_amd: 1000 });

  const res = await apiRequest(`/api/products/${product.id}`, { method: "PATCH", cookie: cookies.admin, body: { net_cost_amd: 650 } });
  assert.equal(res.status, 200);
  assert.equal(Number(res.data.net_cost_amd), 650);

  const { rows } = await pool.query("SELECT * FROM product_price_history WHERE product_id = $1", [product.id]);
  assert.equal(rows.length, 0, "net_cost_amd is not one of the tracked price-history fields");
});

test("PATCH /api/products/:id: a nonexistent id is a 404", async () => {
  const res = await apiRequest("/api/products/999999999", { method: "PATCH", cookie: cookies.admin, body: { bronze_price_amd: 100 } });
  assert.equal(res.status, 404);
});

test("DELETE /api/products/:id: soft-deletes (active: false), doesn't remove the row; a nonexistent id is a 404", async () => {
  const product = await createProduct();
  const res = await apiRequest(`/api/products/${product.id}`, { method: "DELETE", cookie: cookies.admin });
  assert.equal(res.status, 204);

  const { rows } = await pool.query("SELECT active FROM products WHERE id = $1", [product.id]);
  assert.equal(rows[0].active, false);

  const missing = await apiRequest("/api/products/999999999", { method: "DELETE", cookie: cookies.admin });
  assert.equal(missing.status, 404);
});

// --- Promos: valid + boundary -----------------------------------------------------

test("POST /api/products/:id/promos: a valid date range creates a promo; ends_on before starts_on is a 400", async () => {
  const product = await createProduct({ unit_price_amd: 1000 });

  const invalid = await apiRequest(`/api/products/${product.id}/promos`, {
    method: "POST",
    cookie: cookies.admin,
    body: { promo_price_amd: 800, starts_on: "2026-06-10", ends_on: "2026-06-01" },
  });
  assert.equal(invalid.status, 400);

  const valid = await apiRequest(`/api/products/${product.id}/promos`, {
    method: "POST",
    cookie: cookies.admin,
    body: { promo_price_amd: 800, starts_on: "2026-06-01", ends_on: "2026-06-10" },
  });
  assert.equal(valid.status, 201);
  assert.equal(Number(valid.data.promo_price_amd), 800);
});

test("POST /api/products/:id/promos: a negative promo_price_amd is a 400", async () => {
  const product = await createProduct();
  const res = await apiRequest(`/api/products/${product.id}/promos`, {
    method: "POST",
    cookie: cookies.admin,
    body: { promo_price_amd: -1, starts_on: "2026-06-01", ends_on: "2026-06-10" },
  });
  assert.equal(res.status, 400);
});

// --- Bulk price update: preview vs apply -------------------------------------------

test("POST /api/products/bulk-price-update: preview (apply: false) computes changes without writing; apply: true commits them", async () => {
  const product = await createProduct({ unit_price_amd: 1000 });
  await pool.query("UPDATE products SET bronze_price_amd = 1000 WHERE id = $1", [product.id]);

  const preview = await apiRequest("/api/products/bulk-price-update", {
    method: "POST",
    cookie: cookies.admin,
    body: { product_ids: [product.id], price_field: "bronze_price_amd", operation: "fixed", value: 100, apply: false },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.count, 1);
  assert.equal(preview.data.changes[0].new_value, 1100);

  const { rows: unchanged } = await pool.query("SELECT bronze_price_amd FROM products WHERE id = $1", [product.id]);
  assert.equal(Number(unchanged[0].bronze_price_amd), 1000, "a preview call must not write anything");

  const applied = await apiRequest("/api/products/bulk-price-update", {
    method: "POST",
    cookie: cookies.admin,
    body: { product_ids: [product.id], price_field: "bronze_price_amd", operation: "fixed", value: 100, apply: true },
  });
  assert.equal(applied.status, 200);

  const { rows: changed } = await pool.query("SELECT bronze_price_amd FROM products WHERE id = $1", [product.id]);
  assert.equal(Number(changed[0].bronze_price_amd), 1100);
});

test("POST /api/products/bulk-price-update: neither product_ids, brand, nor family is a 400", async () => {
  const res = await apiRequest("/api/products/bulk-price-update", {
    method: "POST",
    cookie: cookies.admin,
    body: { price_field: "bronze_price_amd", operation: "fixed", value: 100, apply: false },
  });
  assert.equal(res.status, 400);
});

test("POST /api/products/bulk-price-update: an invalid price_field is a 400", async () => {
  const res = await apiRequest("/api/products/bulk-price-update", {
    method: "POST",
    cookie: cookies.admin,
    body: { product_ids: [1], price_field: "unit_price_amd", operation: "fixed", value: 100, apply: false },
  });
  assert.equal(res.status, 400);
});

// --- Landing-cost sync diagnostics ------------------------------------------------

test("GET /api/products/sync-diagnostics: counts synced products missing landing cost, by delta (shared table, other tests' fixtures may also count); denied to a sales_manager", async () => {
  const denied = await apiRequest("/api/products/sync-diagnostics", { cookie: cookies.sales_manager });
  assert.equal(denied.status, 403);

  const before = await apiRequest("/api/products/sync-diagnostics", { cookie: cookies.admin });
  assert.equal(before.status, 200);

  const synced = await pool.query(
    "INSERT INTO products (name, unit, unit_price_amd, erp_product_id, landing_cost_amd, synced_at, active) VALUES ($1, 'pcs', 1000, $2, 700, now(), true) RETURNING id",
    [`Itest Diag Synced ${Date.now()}`, `itest-diag-${Date.now()}-a`]
  );
  trackProduct(synced.rows[0].id);
  const missingLanding = await pool.query(
    "INSERT INTO products (name, unit, unit_price_amd, erp_product_id, active) VALUES ($1, 'pcs', 1000, $2, true) RETURNING id",
    [`Itest Diag Missing ${Date.now()}`, `itest-diag-${Date.now()}-b`]
  );
  trackProduct(missingLanding.rows[0].id);

  const after = await apiRequest("/api/products/sync-diagnostics", { cookie: cookies.admin });
  assert.equal(after.status, 200);
  assert.equal(after.data.synced_count - before.data.synced_count, 2, "both new rows have an erp_product_id");
  assert.equal(
    after.data.missing_landing_cost - before.data.missing_landing_cost,
    1,
    "only the one with no landing_cost_amd should count"
  );
});

// --- Unauthenticated ------------------------------------------------------------

test("GET and POST /api/products reject an unauthenticated request with 401", async () => {
  const getRes = await apiRequest("/api/products");
  assert.equal(getRes.status, 401);
  const postRes = await apiRequest("/api/products", { method: "POST", body: { name: "X", unit_price_amd: 100 } });
  assert.equal(postRes.status, 401);
});
