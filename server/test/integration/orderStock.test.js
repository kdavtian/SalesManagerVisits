// Out-of-stock guard (owner, 2026-10-28): no order path may add a product we do not have -- the KAD Motors app, KAD OS, an edit, a
// submitted draft. "Available" = Excel stock minus what other open orders already promised.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let rep, repCookie, directorCookie, partnerUser, partnerCookie, customer, shop, inStock, outStock, unknownStock;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  const director = await createUser("sales_director");
  partnerUser = await createUser("sales_manager");
  [repCookie, directorCookie, partnerCookie] = await Promise.all([rep, director, partnerUser].map((u) => loginAs(u.email)));
  const stamp = Date.now();
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `OS-${stamp}` });
  shop = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `OSK-${stamp}` });
  await pool.query("INSERT INTO partner_links (user_id, customer_id) VALUES ($1, $2)", [partnerUser.id, shop.id]);
  inStock = await createProduct({ unit: "4L", name: `Stock In ${stamp}` });
  outStock = await createProduct({ unit: "4L", name: `Stock Out ${stamp}` });
  unknownStock = await createProduct({ unit: "4L", name: `Stock Unknown ${stamp}` });
  await pool.query("UPDATE products SET stock_qty = 10, bronze_price_amd = 5000, silver_price_amd = 5000 WHERE id = $1", [inStock.id]);
  await pool.query("UPDATE products SET stock_qty = 0, bronze_price_amd = 5000, silver_price_amd = 5000 WHERE id = $1", [outStock.id]);
  await pool.query("UPDATE products SET bronze_price_amd = 5000, silver_price_amd = 5000 WHERE id = $1", [unknownStock.id]);
});
test.after(async () => {
  await pool.query("DELETE FROM partner_links WHERE user_id = $1", [partnerUser.id]);
  await cleanupAll();
  await stopTestServer();
});

const newOrder = async (cookie, items, path = "/api/orders", customerId = customer.id) => {
  const res = await apiRequest(path, { method: "POST", cookie, body: { customer_id: customerId, payment_method: "invoice", payment_term_days: 45, items } });
  if (res.data?.id) trackOrder(res.data.id);
  return res;
};

test("KAD Motors app: an out-of-stock product is refused with its name; in stock and unknown stock pass", async () => {
  const bad = await newOrder(repCookie, [{ product_id: inStock.id, quantity: 1 }, { product_id: outStock.id, quantity: 1 }]);
  assert.equal(bad.status, 409);
  assert.equal(bad.data.code, "out_of_stock");
  assert.deepEqual(bad.data.products.map((p) => p.id), [outStock.id]);
  assert.equal((await newOrder(repCookie, [{ product_id: inStock.id, quantity: 2 }, { product_id: unknownStock.id, quantity: 1 }])).status, 201);
});

test("what other open orders already promised counts: the last pieces cannot be sold twice", async () => {
  await pool.query("UPDATE products SET stock_qty = 3 WHERE id = $1", [inStock.id]);
  const first = await newOrder(repCookie, [{ product_id: inStock.id, quantity: 3 }]);
  assert.equal(first.status, 201);
  const second = await newOrder(repCookie, [{ product_id: inStock.id, quantity: 1 }]);
  assert.equal(second.status, 409, "all 3 are promised to the first order (plus the 2 from the previous test)");
  await pool.query("UPDATE products SET stock_qty = 100 WHERE id = $1", [inStock.id]);
});

test("an edit may keep a line that ran out, but not add an out-of-stock product or more of it", async () => {
  await pool.query("UPDATE products SET stock_qty = 10 WHERE id = $1", [outStock.id]);
  const made = await newOrder(repCookie, [{ product_id: outStock.id, quantity: 2 }]);
  assert.equal(made.status, 201);
  await pool.query("UPDATE products SET stock_qty = 0 WHERE id = $1", [outStock.id]);
  const patch = (items) => apiRequest(`/api/orders/${made.data.id}`, { method: "PATCH", cookie: directorCookie, body: { items } });
  assert.equal((await patch([{ product_id: outStock.id, quantity: 2 }, { product_id: inStock.id, quantity: 1 }])).status, 200, "same quantity of the old line");
  assert.equal((await patch([{ product_id: outStock.id, quantity: 1 }])).status, 200, "less is fine");
  const more = await patch([{ product_id: outStock.id, quantity: 5 }]);
  assert.equal(more.status, 409);
  assert.equal(more.data.code, "out_of_stock");
});

test("KAD OS: out-of-stock and unknown-stock products are refused, also in the preview", async () => {
  const out = await newOrder(partnerCookie, [{ product_id: outStock.id, quantity: 1 }], "/api/partner/orders", shop.id);
  assert.equal(out.status, 409);
  assert.equal(out.data.code, "out_of_stock");
  const unknown = await newOrder(partnerCookie, [{ product_id: unknownStock.id, quantity: 1 }], "/api/partner/orders", shop.id);
  assert.equal(unknown.status, 409, "the KAD OS catalog never shows a product without a stock figure");
  const preview = await apiRequest("/api/partner/preview", { method: "POST", cookie: partnerCookie, body: { items: [{ product_id: outStock.id, quantity: 1 }] } });
  assert.equal(preview.status, 409);
  assert.equal((await newOrder(partnerCookie, [{ product_id: inStock.id, quantity: 1 }], "/api/partner/orders", shop.id)).status, 201);
});

test("a draft is checked again when it is submitted", async () => {
  await pool.query("UPDATE products SET stock_qty = 10 WHERE id = $1", [outStock.id]);
  const draft = await newOrder(repCookie, [{ product_id: outStock.id, quantity: 1 }]);
  assert.equal(draft.status, 201);
  await pool.query("UPDATE orders SET status = 'draft' WHERE id = $1", [draft.data.id]);
  await pool.query("UPDATE products SET stock_qty = 0 WHERE id = $1", [outStock.id]);
  const submit = await apiRequest(`/api/orders/${draft.data.id}/submit`, { method: "POST", cookie: repCookie, body: {} });
  assert.equal(submit.status, 409);
  assert.equal(submit.data.code, "out_of_stock");
});
