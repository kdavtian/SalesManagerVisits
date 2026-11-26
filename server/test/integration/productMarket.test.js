// The product card's Market section (GET /api/market/product/:id, reports/market/productMarket.js): shops with it in stock, competitor
// equivalents of its line and volume, wishes, line potential, lost sales when out of stock; sellers and management only. Made-up names.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const tag = `pm${Date.now().toString(36)}`;
const erpCustomer = `ZZPM${Date.now() % 100000}`;
let rep, warehouse, cookies = {}, shop, product;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  warehouse = await createUser("warehouse_manager");
  for (const [k, u] of Object.entries({ rep, warehouse })) cookies[k] = await loginAs(u.email);
  shop = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.18, lng: 44.51 });
  product = await createProduct({ name: `Castrol MAGNATEC 10W-40 ${tag}`, unit: "4L" });
  await pool.query("UPDATE products SET brand = 'Castrol', size_l = 4, erp_product_id = $2, stock_qty = 0, stock_changed_at = '2026-11-10T08:00:00Z', bronze_price_amd = 20000, retail_price_amd = 25000 WHERE id = $1", [product.id, tag]);
  const { rows: [ch] } = await pool.query(
    "INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, available_products) VALUES ($1, $2, 40.18, 44.51, 5, true, $3) RETURNING id",
    [shop.id, rep.id, [`castrol magnatec 10w-40 ${tag}`, "Other oil"]]
  );
  for (const w of [18000, 19000, 20000]) {
    await pool.query(
      "INSERT INTO competitor_prices (checkin_id, customer_id, user_id, brand_key, line_code, volume, unit, wholesale_amd, retail_amd) VALUES ($1, $2, $3, 'aral', 'pcmo_10w40', 4, 'L', $4, $5)",
      [ch.id, shop.id, rep.id, w, w + 3000]
    );
  }
  await pool.query("INSERT INTO product_wishes (customer_id, product_id, quantity) VALUES ($1, $2, 5)", [shop.id, product.id]);
  // 12 sold in each of the last 3 whole months -> 12 a month
  for (let m = 1; m <= 3; m++) {
    await pool.query(
      `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, qty)
       VALUES ($1, $2, (date_trunc('month', now() AT TIME ZONE 'Asia/Yerevan') - ($3 || ' months')::interval + interval '3 days')::date, $4, 12)`,
      [erpCustomer, `${tag}-${m}`, String(m), tag]
    );
  }
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erpCustomer]);
  await cleanupAll();
  await stopTestServer();
});

test("in stock at shops, competitors of the line and volume, wishes, sales, out of stock; warehouse gets 403", async () => {
  const r = await apiRequest(`/api/market/product/${product.id}`, { cookie: cookies.rep });
  assert.equal(r.status, 200);
  assert.ok(r.data.shelf.on_shelf >= 1);
  assert.deepEqual([r.data.wishes.customers, r.data.wishes.quantity], [1, 5]);
  assert.equal(r.data.sales.monthly_qty, 12);
  assert.equal(r.data.line.code, "pcmo_10w40");
  const aral = r.data.line.competitors.find((c) => c.brand_key === "aral");
  assert.deepEqual([aral.wholesale, aral.retail, aral.gap_wholesale_pct], [19000, 22000, 5]);
  assert.deepEqual([r.data.out_of_stock.monthly_qty, r.data.out_of_stock.litres, r.data.out_of_stock.wish_customers], [12, 48, 1]);
  assert.equal((await apiRequest(`/api/market/product/${product.id}`, { cookie: cookies.warehouse })).status, 403);
  assert.equal((await apiRequest("/api/market/product/99999999", { cookie: cookies.rep })).status, 404);
});
