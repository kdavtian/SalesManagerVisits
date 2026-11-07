// Owner, 2026-11-07: admin and accountants add a product in a few taps; the same brand + name + size is refused unless confirmed, and the
// Excel sync later links to the app-made product (same brand, name and "<size>L" unit) instead of adding a second one.
process.env.ERP_SYNC_KEY = "itest-sync-key";
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let accCookie, repCookie;
const made = [];
test.before(async () => {
  await startTestServer();
  accCookie = await loginAs((await createUser("accountant")).email);
  repCookie = await loginAs((await createUser("sales_manager")).email);
});
test.after(async () => {
  if (made.length) await pool.query("DELETE FROM products WHERE id = ANY($1)", [made]);
  await cleanupAll();
  await stopTestServer();
});

test("an accountant adds a product with the Excel fields; a duplicate is refused until confirmed; a rep cannot add", async () => {
  const brand = `ITB${Date.now()}`;
  const body = { brand, name: " Edge  5W-30 ", unit: "4L", size_l: 4, family: "Edge", unit_price_amd: 20000, bronze_price_amd: 20000, silver_price_amd: 19000, hc_code: "000123" };
  assert.equal((await apiRequest("/api/products", { method: "POST", cookie: repCookie, body })).status, 403);
  const first = await apiRequest("/api/products", { method: "POST", cookie: accCookie, body });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  made.push(first.data.id);
  assert.equal(first.data.name, "Edge  5W-30".trim());
  assert.equal(Number(first.data.silver_price_amd), 19000);
  assert.equal(first.data.family, "Edge");
  assert.equal(first.data.hc_code, "000123");
  assert.equal(Number(first.data.size_l), 4);
  const dup = await apiRequest("/api/products", { method: "POST", cookie: accCookie, body: { ...body, name: "edge 5w-30", unit: "4 L" } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.code, "duplicate");
  assert.equal(dup.data.existing.id, first.data.id);
  const forced = await apiRequest("/api/products", { method: "POST", cookie: accCookie, body: { ...body, unit: "5L", size_l: 5 } });
  assert.equal(forced.status, 201); // a different size is a different product
  made.push(forced.data.id);

  // the Excel sync links to the app-made product instead of adding a second one
  const erpId = `${brand}Edge 5W-304`;
  const sync = await apiRequest("/api/erp-sync", {
    method: "POST",
    headers: { "X-Sync-Key": "itest-sync-key" },
    body: { customers: [], products: [{ erp_product_id: erpId, name: "Edge 5W-30", brand, unit: "4L", unit_price_amd: 21000, bronze_price_amd: 21000, silver_price_amd: 20000 }] },
  });
  assert.equal(sync.status, 200, JSON.stringify(sync.data));
  const { rows } = await pool.query("SELECT id, erp_product_id FROM products WHERE brand = $1 AND unit = '4L'", [brand]);
  assert.equal(rows.length, 1, "no second product");
  assert.equal(rows[0].id, first.data.id);
  assert.equal(rows[0].erp_product_id, erpId);
});
