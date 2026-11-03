// The warehouse manager gets no order amounts and no bronze / silver / gold prices in ANY answer (owner, 2026-11-03), but keeps retail
// prices and quantities; other roles are unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { stripKeys, keysToHide } from "../../src/middleware/roleRedaction.js";

let admin, wh, rep, adminCookie, whCookie, customer, product, orderId;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  wh = await createUser("warehouse_manager");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  whCookie = await loginAs(wh.email);
  customer = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id });
  product = await createProduct({ unit_price_amd: 5000 });
  await pool.query("UPDATE products SET bronze_price_amd = 5000, silver_price_amd = 4800, gold_price_amd = 4600, retail_price_amd = 6500 WHERE id = $1", [product.id]);
  const { rows: [o] } = await pool.query("INSERT INTO orders (customer_id, user_id, status, total_amd, order_code) VALUES ($1, $2, 'confirmed', 10000, $3) RETURNING id", [customer.id, rep.id, `WR${process.pid}`]);
  orderId = o.id;
  trackOrder(orderId);
  await pool.query("INSERT INTO order_items (order_id, product_id, product_name, brand, unit_price_amd, quantity, line_total_amd) VALUES ($1, $2, 'P', 'B', 5000, 2, 10000)", [orderId, product.id]);
});
test.after(async () => {
  await pool.query("DELETE FROM order_items WHERE order_id = $1", [orderId]);
  await cleanupAll();
  await stopTestServer();
});

const text = (r) => JSON.stringify(r.data);

test("stripKeys: any depth, arrays, Dates and plain values untouched", () => {
  const hidden = keysToHide("warehouse_manager");
  const when = new Date();
  const out = stripKeys({ rows: [{ id: 1, total_amd: 5, qty: 2, at: when, items: [{ unit_price_amd: 3, name: "x" }] }], retail_price_amd: 9 }, hidden);
  assert.deepEqual(out, { rows: [{ id: 1, qty: 2, at: when, items: [{ name: "x" }] }], retail_price_amd: 9 });
  assert.equal(keysToHide("admin").size, 0);
});

test("the warehouse manager's order answers carry no amounts; the admin's do", async () => {
  const wList = await apiRequest("/api/orders", { cookie: whCookie });
  assert.equal(wList.status, 200);
  assert.ok(text(wList).includes(String(orderId)), "the order is listed");
  assert.ok(!/total_amd|line_total_amd|unit_price_amd|discount_amd/.test(text(wList)));
  const wOne = await apiRequest(`/api/orders/${orderId}`, { cookie: whCookie });
  assert.equal(wOne.status, 200);
  assert.ok(!/total_amd|line_total_amd|unit_price_amd|list_price_amd/.test(text(wOne)));
  assert.ok(text(wOne).includes('"quantity"'), "quantities stay");
  const aOne = await apiRequest(`/api/orders/${orderId}`, { cookie: adminCookie });
  assert.ok(/total_amd/.test(text(aOne)) && /unit_price_amd/.test(text(aOne)));
});

test("the warehouse manager's product answers carry retail but no bronze / silver / gold, cost or tier price", async () => {
  const w = await apiRequest("/api/products", { cookie: whCookie });
  assert.equal(w.status, 200);
  const row = w.data.find((p) => p.id === product.id);
  assert.ok(row);
  for (const k of ["bronze_price_amd", "silver_price_amd", "gold_price_amd", "unit_price_amd", "net_cost_amd", "landing_cost_amd", "effective_standard_amd", "effective_special_amd"]) {
    assert.equal(k in row, false, `${k} must not be sent`);
  }
  assert.equal(Number(row.retail_price_amd), 6500);
  assert.ok("effective_retail_amd" in row);
  const a = await apiRequest("/api/products", { cookie: adminCookie });
  const arow = a.data.find((p) => p.id === product.id);
  assert.equal(Number(arow.silver_price_amd), 4800);
  const rWh = await apiRequest("/api/products", { cookie: await loginAs(rep.email) });
  assert.equal(Number(rWh.data.find((p) => p.id === product.id).silver_price_amd), 4800, "a rep still sees silver");
});

test("staff structure: the warehouse manager sees the whole structure and his boss, with no pay; a rep gets 403", async () => {
  const { rows: [boss] } = await pool.query("INSERT INTO staff_members (name, position, kind, fixed_salary_amd) VALUES ($1, 'Ops director', 'director', 900000) RETURNING id", [`WR Boss ${process.pid}`]);
  const { rows: [me] } = await pool.query("INSERT INTO staff_members (name, position, kind, user_id, reports_to, fixed_salary_amd) VALUES ($1, 'Warehouse manager', 'warehouse', $2, $3, 400000) RETURNING id", [`WR Me ${process.pid}`, wh.id, boss.id]);
  try {
    const res = await apiRequest("/api/staff/structure", { cookie: whCookie });
    assert.equal(res.status, 200);
    assert.equal(res.data.boss.name, `WR Boss ${process.pid}`);
    assert.ok(res.data.people.some((p) => p.id === me.id && p.mine === true));
    assert.ok(!/salary|commission|pay_keys|fixed/.test(text(res)), "no pay in the structure");
    assert.equal((await apiRequest("/api/staff/structure", { cookie: await loginAs(rep.email) })).status, 403);
  } finally {
    await pool.query("DELETE FROM staff_members WHERE id = ANY($1)", [[me.id, boss.id]]);
  }
});
