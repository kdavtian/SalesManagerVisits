// Owner, 2026-11-07: admin, CEO and the accountant correct a confirmed / packed / delivered order; a reason is required, the order before
// and after is kept, kept lines keep their price, and the rep is told. Reps and directors cannot; a draft / submitted order uses Edit.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let acc, rep, accCookie, repCookie, dirCookie, customer, p1, p2;
test.before(async () => {
  await startTestServer();
  acc = await createUser("accountant");
  rep = await createUser("sales_manager");
  accCookie = await loginAs(acc.email);
  repCookie = await loginAs(rep.email);
  dirCookie = await loginAs((await createUser("sales_director")).email);
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `OC${Date.now()}` });
  p1 = await createProduct({ unit_price_amd: 10000 });
  p2 = await createProduct({ unit_price_amd: 3000 });
  await pool.query("UPDATE products SET bronze_price_amd = unit_price_amd, silver_price_amd = unit_price_amd, stock_qty = 100 WHERE id = ANY($1)", [[p1.id, p2.id]]);
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

async function deliveredOrder() {
  const { rows: [o] } = await pool.query(
    "INSERT INTO orders (customer_id, user_id, status, total_amd, payment_method) VALUES ($1, $2, 'delivered', 18000, 'invoice') RETURNING *",
    [customer.id, rep.id]
  );
  trackOrder(o.id);
  await pool.query("INSERT INTO order_items (order_id, product_id, product_name, unit_price_amd, quantity, line_total_amd) VALUES ($1, $2, 'P1', 9000, 2, 18000)", [o.id, p1.id]);
  return o;
}

test("only admin / CEO / accountant correct; a reason is required; a submitted order uses Edit", async () => {
  const o = await deliveredOrder();
  const body = { items: [{ product_id: p1.id, quantity: 1 }], reason: "Wrong quantity typed" };
  assert.equal((await apiRequest(`/api/orders/${o.id}/correct`, { method: "POST", cookie: repCookie, body })).status, 403);
  assert.equal((await apiRequest(`/api/orders/${o.id}/correct`, { method: "POST", cookie: dirCookie, body })).status, 403);
  const noReason = await apiRequest(`/api/orders/${o.id}/correct`, { method: "POST", cookie: accCookie, body: { ...body, reason: " " } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.data.code, "reason_required");
  await pool.query("UPDATE orders SET status = 'submitted' WHERE id = $1", [o.id]);
  assert.equal((await apiRequest(`/api/orders/${o.id}/correct`, { method: "POST", cookie: accCookie, body })).data.code, "use_edit");
});

test("a delivered order is corrected: kept lines keep their price, a new product gets the customer's price, before/after is logged, the rep is told", async () => {
  const o = await deliveredOrder();
  const r = await apiRequest(`/api/orders/${o.id}/correct`, {
    method: "POST",
    cookie: accCookie,
    body: { items: [{ product_id: p1.id, quantity: 1 }, { product_id: p2.id, quantity: 3 }], reason: "One canister was returned, 3 filters added" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, "delivered");
  const byProduct = Object.fromEntries(r.data.items.map((i) => [i.product_id, Number(i.unit_price_amd)]));
  assert.equal(byProduct[p1.id], 9000, "the price the order had");
  assert.equal(byProduct[p2.id], 3000, "the customer's price for a product added now");
  assert.equal(Number(r.data.total_amd), 9000 + 9000);
  assert.equal(r.data.corrections.length, 1);
  assert.equal(r.data.corrections[0].before.total_amd, 18000);
  assert.equal(r.data.corrections[0].after.total_amd, 18000);
  assert.match(r.data.corrections[0].reason, /returned/);
  assert.equal(r.data.corrections[0].corrected_by_name, acc.name);
  const detail = await apiRequest(`/api/orders/${o.id}`, { cookie: repCookie });
  assert.equal(detail.data.corrections.length, 1, "the rep sees the correction on the order");
  await new Promise((res) => setTimeout(res, 300));
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'order_corrected'", [rep.id]);
  assert.equal(rows[0].n, 1);
});
