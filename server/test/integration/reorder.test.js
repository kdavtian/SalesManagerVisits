// "Order usual" / "Reorder": the usual basket, one past order's lines, the ordering rhythm (chip) and the
// visit-first reason, all from the same order history.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { refreshOrderRhythm } from "../../src/orders/orderRhythm.js";
import { visitPriorities } from "../../src/field/visitPriorities.js";
import { yerevanToday } from "../../src/utils/yerevanDate.js";
import { addDays } from "../../src/reports/volumeReport.js";

const stamp = Date.now();
const erpId = `ITEST-RO-${stamp}`;
let director, rep, other, repCookie, otherCookie, customer, edge, drum, retired, appOnly;

// Yerevan calendar day, like the server (a UTC date is one day behind between 20:00 and 24:00 UTC)
const daysAgo = (n) => addDays(yerevanToday(), -n);
async function line(orderId, daysBack, product, qty, price = 10000) {
  await pool.query(
    `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, brand, product_name, qty, unit_price_amd, revenue_amd)
     VALUES ($1, $2, $3::date, $4, 'Castrol', $5, $6, $7, $8)`,
    [erpId, orderId, daysAgo(daysBack), product.erp_product_id, product.name, qty, price, qty * price]
  );
}

test.before(async () => {
  await startTestServer();
  director = await createUser("sales_director");
  rep = await createUser("sales_manager");
  other = await createUser("sales_manager");
  repCookie = await loginAs(rep.email);
  otherCookie = await loginAs(other.email);
  customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, erp_customer_id: erpId, name: `ITEST Reorder ${stamp}`, sales_channel: "retail" });
  edge = await createProduct({ name: `ITEST Edge ${stamp}`, unit: "4L" });
  drum = await createProduct({ name: `ITEST Drum ${stamp}`, unit: "208L" });
  retired = await createProduct({ name: `ITEST Retired ${stamp}`, unit: "1L" });
  appOnly = await createProduct({ name: `ITEST App only ${stamp}`, unit: "1L" });
  for (const [p, key] of [[edge, "edge"], [drum, "drum"], [retired, "ret"], [appOnly, "app"]]) {
    await pool.query("UPDATE products SET erp_product_id = $2 WHERE id = $1", [p.id, `ITEST-${key}-${stamp}`]);
    p.erp_product_id = `ITEST-${key}-${stamp}`;
  }
  await pool.query("UPDATE products SET active = false WHERE id = $1", [retired.id]);
  // Five orders every ~10 days, the newest 35 days ago (so the rhythm says "late"): Edge every time (qty 4, 4, 6, 4, 4),
  // the drum only in two of them, a retired product once.
  const plan = [[85, edge, 4], [75, edge, 4], [65, edge, 6], [55, edge, 4], [45, edge, 4], [35, edge, 4]];
  let i = 0;
  for (const [back, product, qty] of plan) await line(`RO-${stamp}-${++i}`, back, product, qty);
  await line(`RO-${stamp}-2`, 75, drum, 1);
  await line(`RO-${stamp}-4`, 55, drum, 1);
  await line(`RO-${stamp}-6`, 35, retired, 2);
  await refreshOrderRhythm();
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erpId]);
  await pool.query("DELETE FROM customer_order_rhythm WHERE erp_customer_id = $1", [erpId]);
  await cleanupAll();
  await stopTestServer();
});

test("the usual basket: regular products with their typical quantity, retired ones left out, rhythm and state", async () => {
  const res = await apiRequest(`/api/customers/${customer.id}/reorder-profile`, { cookie: repCookie });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const { items, cadence } = res.data;
  assert.equal(cadence.median_gap_days, 10);
  assert.equal(cadence.days_since_order, 35);
  assert.equal(cadence.state, "late");
  const names = items.map((i) => i.name);
  assert.ok(names.includes(edge.name) && names.includes(drum.name));
  assert.ok(!names.includes(retired.name), "a product that is no longer in the catalog is not offered");
  assert.equal(items.find((i) => i.product_id === edge.id).quantity, 4, "typical quantity is the median");
  assert.equal(items.find((i) => i.product_id === drum.id).times, 2);
  assert.ok(items.find((i) => i.product_id === edge.id).due);
});

test("Reorder: the lines of one past order, mapped to today's catalog", async () => {
  const res = await apiRequest(`/api/customers/${customer.id}/reorder-profile?from=erp:RO-${stamp}-6`, { cookie: repCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.lines.source, `erp:RO-${stamp}-6`);
  assert.deepEqual(res.data.lines.lines.map((l) => [l.product_id, l.quantity]), [[edge.id, 4]]);
  assert.equal(res.data.lines.not_available, 1, "the retired product is reported, not silently dropped");
});

test("Repeat last order: from=last resolves to the newest order without the client knowing its id", async () => {
  const res = await apiRequest(`/api/customers/${customer.id}/reorder-profile?from=last`, { cookie: repCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.lines.source, `erp:RO-${stamp}-6`);
  assert.deepEqual(res.data.lines.lines.map((l) => [l.product_id, l.quantity]), [[edge.id, 4]]);
  const none = await apiRequest(`/api/customers/${customer.id}/reorder-profile?from=last`, { cookie: otherCookie });
  assert.equal(none.data.lines, null, "a rep without access gets nothing to repeat");
});

test("a rep without access to the customer gets no history; the list and map carry the reorder chip data", async () => {
  const empty = await apiRequest(`/api/customers/${customer.id}/reorder-profile`, { cookie: otherCookie });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.items, []);

  const list = await apiRequest("/api/customers", { cookie: repCookie });
  const row = list.data.find((c) => c.id === customer.id);
  assert.equal(row.reorder_state, "late");
  assert.equal(row.reorder_gap_days, 10);
  const facts = await apiRequest(`/api/customers/map-facts?ids=${customer.id}`, { cookie: repCookie });
  assert.equal(facts.data[customer.id].reorder_state, "late");
});

test("an app order newer than the synced history clears the chip and shows in the usual basket", async () => {
  const { rows: [order] } = await pool.query(
    "INSERT INTO orders (customer_id, user_id, status, total_amd) VALUES ($1, $2, 'submitted', 40000) RETURNING id",
    [customer.id, rep.id]
  );
  trackOrder(order.id);
  await pool.query("INSERT INTO order_items (order_id, product_id, product_name, unit_price_amd, quantity, line_total_amd) VALUES ($1, $2, $3, 10000, 4, 40000)", [order.id, appOnly.id, appOnly.name]);
  const list = await apiRequest("/api/customers", { cookie: repCookie });
  assert.equal(list.data.find((c) => c.id === customer.id).reorder_state, null);
  const res = await apiRequest(`/api/customers/${customer.id}/reorder-profile?from=app:${order.id}`, { cookie: repCookie });
  assert.deepEqual(res.data.lines.lines.map((l) => [l.product_id, l.quantity]), [[appOnly.id, 4]]);
});

test("visit first: the usual gap has passed -> a gentle reorder-due reason", async () => {
  // Re-date the history so the newest order is 12 days old (gap 10): due, not yet late.
  await pool.query("UPDATE erp_order_lines SET order_date = order_date + 23 WHERE erp_customer_id = $1", [erpId]);
  await pool.query("DELETE FROM orders WHERE customer_id = $1", [customer.id]);
  await refreshOrderRhythm();
  const picks = await visitPriorities(rep.id, 50);
  const mine = picks.find((p) => p.customer_id === customer.id);
  assert.ok(mine, "customer is listed");
  assert.ok(mine.reasons.some((r) => r.type === "reorder_due"), JSON.stringify(mine.reasons));
});
