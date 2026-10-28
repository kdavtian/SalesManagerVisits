// Wished products (owner, 2026-10-28): what a customer wants but we do not have is written down as a wish (out-of-stock catalog product or a
// typed new one), management is told, Reports > Wished products groups them, and the rep is told once the product is back after a sync.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { markWishesBackInStock } from "../../src/productWishes.js";

let rep, repCookie, director, directorCookie, partnerUser, partnerCookie, customer, other, shop, gone;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  director = await createUser("sales_director");
  partnerUser = await createUser("sales_manager");
  [repCookie, directorCookie, partnerCookie] = await Promise.all([rep, director, partnerUser].map((u) => loginAs(u.email)));
  const stamp = Date.now();
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `PW-${stamp}` });
  other = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `PWO-${stamp}` });
  shop = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `PWK-${stamp}` });
  await pool.query("INSERT INTO partner_links (user_id, customer_id) VALUES ($1, $2)", [partnerUser.id, shop.id]);
  gone = await createProduct({ unit: "4L", name: `Wish Gone ${stamp}` });
  await pool.query("UPDATE products SET stock_qty = 0 WHERE id = $1", [gone.id]);
});
test.after(async () => {
  await pool.query("DELETE FROM partner_links WHERE user_id = $1", [partnerUser.id]);
  await cleanupAll();
  await stopTestServer();
});

const wish = (cookie, body) => apiRequest("/api/wishes", { method: "POST", cookie, body });
async function notificationsOf(userId, type) {
  for (let i = 0; i < 20; i++) {
    const { rows } = await pool.query("SELECT title, body FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY id", [userId, type]);
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

test("a rep wishes an out-of-stock product and a new one; management is told, bad input is refused", async () => {
  const a = await wish(repCookie, { customer_id: customer.id, product_id: gone.id, quantity: 6, note: "every month" });
  assert.equal(a.status, 201);
  assert.equal(a.data.product_id, gone.id);
  assert.equal((await wish(repCookie, { customer_id: other.id, product_id: gone.id, quantity: 2 })).status, 201);
  const b = await wish(repCookie, { customer_id: customer.id, custom_name: "  Castrol  Magnatec 5W-40 1L ", quantity: 3 });
  assert.equal(b.status, 201);
  assert.equal((await wish(repCookie, { customer_id: other.id, custom_name: "castrol magnatec 5w-40 1l" })).status, 201);

  assert.equal((await wish(repCookie, { customer_id: customer.id })).status, 400, "a product or a name is needed");
  assert.equal((await wish(repCookie, { customer_id: customer.id, custom_name: "x", quantity: 0 })).status, 400);
  assert.equal((await wish(repCookie, { customer_id: 0, custom_name: "x" })).status, 404);

  const told = await notificationsOf(director.id, "product_wish");
  assert.ok(told.some((n) => n.title.includes(gone.name) && n.body.includes(customer.name)), "the director hears about the wish");
  assert.equal((await notificationsOf(rep.id, "product_wish")).length, 0, "the rep who wrote it is not told about his own wish");

  const mine = await apiRequest(`/api/wishes?customer_id=${customer.id}`, { cookie: repCookie });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.data.map((w) => w.product_id).sort(), [gone.id, null].sort());
});

test("Reports > Wished products groups by product and by name, most customers first; reps cannot open it", async () => {
  const res = await apiRequest("/api/reports/product-wishes?period=d30", { cookie: directorCookie });
  assert.equal(res.status, 200);
  const ours = res.data.rows.filter((r) => r.product_id === gone.id || r.name.toLowerCase().includes("magnatec 5w-40 1l"));
  assert.equal(ours.length, 2);
  const byProduct = ours.find((r) => r.product_id === gone.id);
  assert.equal(byProduct.customers, 2);
  assert.equal(byProduct.quantity, 8);
  assert.equal(byProduct.in_stock_now, false);
  const byName = ours.find((r) => r.new_product);
  assert.equal(byName.customers, 2, "the same typed name, written differently, is one row");
  assert.equal(byName.items.length, 2);
  assert.equal((await apiRequest("/api/reports/product-wishes", { cookie: repCookie })).status, 403);
});

test("KAD OS: the customer wishes for its own shop and sees its wishes", async () => {
  const made = await apiRequest("/api/partner/wishes", { method: "POST", cookie: partnerCookie, body: { product_id: gone.id, quantity: 4 } });
  assert.equal(made.status, 201);
  assert.equal(made.data.name, gone.name);
  const { rows } = await pool.query("SELECT customer_id, source FROM product_wishes WHERE id = $1", [made.data.id]);
  assert.deepEqual(rows[0], { customer_id: shop.id, source: "kados" });
  const list = await apiRequest("/api/partner/wishes", { cookie: partnerCookie });
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.wishes.map((w) => w.id), [made.data.id], "only this shop's wishes");
});

test("back in stock after a sync: wishes are marked once and the rep gets one notification", async () => {
  assert.equal((await markWishesBackInStock()).filter((w) => w.product_id === gone.id).length, 0, "still out of stock");
  await pool.query("UPDATE products SET stock_qty = 20 WHERE id = $1", [gone.id]);
  const marked = (await markWishesBackInStock()).filter((w) => w.product_id === gone.id);
  assert.equal(marked.length, 3, "two from the app, one from KAD OS");
  const told = await notificationsOf(rep.id, "wish_back_in_stock");
  assert.equal(told.length, 1);
  assert.ok(told[0].body.includes(customer.name) && told[0].body.includes(shop.name));
  assert.equal((await markWishesBackInStock()).filter((w) => w.product_id === gone.id).length, 0, "never twice");
  const list = await apiRequest("/api/partner/wishes", { cookie: partnerCookie });
  assert.ok(list.data.wishes[0].back_in_stock_at, "KAD OS shows it is back");
});
