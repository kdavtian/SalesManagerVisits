// Order lines are saved in the products page's order, whatever order the
// rep added them in.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

test.before(startTestServer);
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("order items are stored sorted by brand, viscosity and size", async () => {
  const director = await createUser("sales_director");
  const cookie = await loginAs(director.email);
  const customer = await createCustomer({ created_by: director.id });
  const tag = Math.random().toString(36).slice(2, 7);
  const mk = async (name, brand, unit) => {
    const p = await createProduct({ name: `${name} ${tag}`, unit });
    await pool.query("UPDATE products SET brand = $2 WHERE id = $1", [p.id, brand]);
    return p;
  };
  const lotos20 = await mk("Lotos 10W-40", "Lotos", "20L");
  const castrol4 = await mk("Edge 5W-30", "Castrol", "4L");
  const castrol1 = await mk("Edge 5W-30", "Castrol", "1L");
  const r = await apiRequest("/api/orders", {
    method: "POST",
    cookie,
    body: {
      customer_id: customer.id,
      payment_method: "cash",
      items: [lotos20, castrol4, castrol1].map((p) => ({ product_id: p.id, quantity: 1 })),
    },
  });
  assert.equal(r.status, 201);
  trackOrder(r.data.id);
  const { rows } = await pool.query("SELECT product_id FROM order_items WHERE order_id = $1 ORDER BY id", [r.data.id]);
  assert.deepEqual(
    rows.map((x) => x.product_id),
    [castrol1.id, castrol4.id, lotos20.id]
  );
});
