// Special pricelist of a Gold customer: PUT /api/customers/:id/product-prices, and the order picks the saved price.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let admin, adminCookie, rep, repCookie, gold, silverCustomer, p1, p2;
test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
  rep = await createUser("sales_manager");
  repCookie = await loginAs(rep.email);
  gold = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: `SP-${Date.now()}` });
  silverCustomer = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id });
  await pool.query("UPDATE customers SET customer_tier = 'gold' WHERE id = $1", [gold.id]);
  await pool.query("UPDATE customers SET customer_tier = 'silver' WHERE id = $1", [silverCustomer.id]);
  p1 = await createProduct({ unit: "4L" });
  p2 = await createProduct({ unit: "1L" });
  for (const p of [p1, p2]) await pool.query("UPDATE products SET bronze_price_amd = 60000, silver_price_amd = 57000, gold_price_amd = 54000 WHERE id = $1", [p.id]);
});
test.after(async () => {
  await pool.query("DELETE FROM customer_product_prices WHERE customer_id = ANY($1)", [[gold.id, silverCustomer.id]]);
  await cleanupAll();
  await stopTestServer();
});

const put = (cookie, id, prices) => apiRequest(`/api/customers/${id}/product-prices`, { method: "PUT", cookie, body: { prices } });

test("only reviewer roles save special prices, only for Gold customers; null removes one", async () => {
  assert.equal((await put(repCookie, gold.id, [{ product_id: p1.id, price_amd: 50000 }])).status, 403);
  assert.equal((await put(adminCookie, silverCustomer.id, [{ product_id: p1.id, price_amd: 50000 }])).status, 409);
  assert.equal((await put(adminCookie, gold.id, [])).status, 400);
  assert.equal((await put(adminCookie, gold.id, [{ product_id: p1.id, price_amd: -5 }])).status, 400);
  const saved = await put(adminCookie, gold.id, [{ product_id: p1.id, price_amd: 50000 }, { product_id: p2.id, price_amd: 57000 }]);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.map((r) => [r.product_id, r.price_amd]).sort(), [[p1.id, 50000], [p2.id, 57000]].sort());
  const again = await put(adminCookie, gold.id, [{ product_id: p2.id, price_amd: null }]);
  assert.deepEqual(again.data.map((r) => r.product_id), [p1.id]);
  assert.deepEqual((await apiRequest(`/api/customers/${gold.id}/product-prices`, { cookie: repCookie })).data.map((r) => r.price_amd), [50000], "everyone can read them");
});

test("a new order for the Gold customer uses the special price automatically, the other product its Gold list price", async () => {
  const res = await apiRequest("/api/orders", {
    method: "POST",
    cookie: repCookie,
    body: { customer_id: gold.id, payment_method: "invoice", items: [{ product_id: p1.id, quantity: 2 }, { product_id: p2.id, quantity: 1 }] },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackOrder(res.data.id);
  const byProduct = Object.fromEntries(res.data.items.map((i) => [i.product_id, Number(i.unit_price_amd)]));
  assert.equal(byProduct[p1.id], 50000, "special price");
  assert.equal(byProduct[p2.id], 54000, "Gold list price");
});
