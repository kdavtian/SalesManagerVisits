// Orders are priced server-side from the customer's tier; Gold customers can
// have individual prices set by director-and-above roles.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

test.before(startTestServer);
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

async function order(cookie, customerId, productId, extra = {}) {
  const r = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: { customer_id: customerId, items: [{ product_id: productId, quantity: 1, ...extra }], payment_method: "cash" },
  });
  assert.equal(r.status, 201);
  trackOrder(r.data.id);
  return r.data;
}

test("tier prices, silver fallback and individual gold prices", async () => {
  const director = await createUser("sales_director");
  const manager = await createUser("sales_manager");
  const dCookie = await loginAs(director.email);
  const mCookie = await loginAs(manager.email);
  const product = await createProduct({ unit_price_amd: 1000 });
  await pool.query("UPDATE products SET bronze_price_amd = 1000, silver_price_amd = 900, gold_price_amd = 800 WHERE id = $1", [product.id]);
  const noBronze = await createProduct({ unit_price_amd: 0 });
  await pool.query("UPDATE products SET bronze_price_amd = NULL, silver_price_amd = 700 WHERE id = $1", [noBronze.id]);

  const mk = async (tier) => {
    const c = await createCustomer({ created_by: director.id, assigned_manager_id: manager.id });
    await pool.query("UPDATE customers SET customer_tier = $2 WHERE id = $1", [c.id, tier]);
    return c;
  };
  const price = (o) => Number(o.items?.[0]?.unit_price_amd ?? o.lines?.[0]?.unit_price_amd);

  assert.equal(price(await order(dCookie, (await mk("bronze")).id, product.id)), 1000);
  assert.equal(price(await order(dCookie, (await mk("silver")).id, product.id)), 900);
  assert.equal(price(await order(dCookie, (await mk("bronze")).id, noBronze.id)), 700);

  const gold = await mk("gold");
  assert.equal(price(await order(dCookie, gold.id, product.id)), 800);
  // A rep cannot set a price...
  assert.equal(price(await order(mCookie, gold.id, product.id, { unit_price_amd: 1, price_override: true })), 800);
  // ...a director can, and it is remembered for that customer.
  assert.equal(price(await order(dCookie, gold.id, product.id, { unit_price_amd: 750, price_override: true })), 750);
  assert.equal(price(await order(mCookie, gold.id, product.id)), 750);
  const saved = await apiRequest(`/api/customers/${gold.id}/product-prices`, { cookie: mCookie });
  assert.deepEqual(saved.data, [{ product_id: product.id, price_amd: 750 }]);
  // Non-gold customers ignore overrides.
  assert.equal(price(await order(dCookie, (await mk("silver")).id, product.id, { unit_price_amd: 1, price_override: true })), 900);
});
