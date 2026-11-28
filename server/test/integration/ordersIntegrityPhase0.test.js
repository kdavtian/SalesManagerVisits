// Phase 0 "stop losses" (owner's improvement plan, 2026-11-28), items 0.3, 0.4, 0.17, 0.18:
//   0.3  a failed delivery puts the order back in the planner (fail, then plan again);
//   0.4  a correction keeps the order's line ids and the same goods cannot be returned twice (return, correct, return again);
//   0.17 Lily is never handed an order sent back or cancelled; a correction after her document flags it;
//   0.18 a signed order is corrected only by the admin or the CEO.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { createIntegrationToken } from "../../src/erp/integrationTokens.js";

let admin, acc, driver, warehouse, adminCookie, accCookie, driverCookie, warehouseCookie, customer, p1, p2, token;
const tokenIds = [];
const routeIds = [];
const orderIds = [];
test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  acc = await createUser("accountant");
  driver = await createUser("delivery_manager");
  warehouse = await createUser("warehouse_manager");
  adminCookie = await loginAs(admin.email);
  accCookie = await loginAs(acc.email);
  driverCookie = await loginAs(driver.email);
  warehouseCookie = await loginAs(warehouse.email);
  customer = await createCustomer({ created_by: admin.id, erp_customer_id: `P0-${Date.now()}` });
  p1 = await createProduct({ unit_price_amd: 10000 });
  p2 = await createProduct({ unit_price_amd: 3000 });
  await pool.query("UPDATE products SET bronze_price_amd = unit_price_amd, silver_price_amd = unit_price_amd, stock_qty = 100 WHERE id = ANY($1)", [[p1.id, p2.id]]);
  const t = await createIntegrationToken({ name: `p0-${Date.now()}`, createdBy: admin.id, testMode: false });
  tokenIds.push(t.id);
  token = t.token;
});
test.after(async () => {
  if (routeIds.length) {
    await pool.query("DELETE FROM route_stops WHERE route_id = ANY($1)", [routeIds]);
    await pool.query("DELETE FROM delivery_routes WHERE id = ANY($1)", [routeIds]);
  }
  if (tokenIds.length) await pool.query("DELETE FROM integration_tokens WHERE id = ANY($1)", [tokenIds]);
  // corrections and cancellations here queue accounting-group messages; once the orders are deleted the group job would announce them
  // as cancelled in the next test file (orderGroupPost.test.js counts what its job finds)
  await new Promise((r) => setTimeout(r, 300)); // the routes' "sync soon" hooks are not awaited
  await cleanupAll();
  await pool.query("DELETE FROM group_posts WHERE ref_id = ANY($1)", [orderIds]);
  await stopTestServer();
});

const ref = (id) => `ord_${String(id).padStart(6, "0")}`;
const lily = (path, method = "GET", body) => apiRequest(`/api/integration/v1${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body });

async function newOrder(status, { lines = [[p1.id, 2, 9000]], accounting = null } = {}) {
  const total = lines.reduce((s, [, q, price]) => s + q * price, 0);
  const { rows: [o] } = await pool.query(
    `INSERT INTO orders (customer_id, user_id, status, total_amd, payment_method, accounting_status, accounting_doc_type, accounting_requested_at, accounting_requested_by, accounting_is_test)
     VALUES ($1, $2, $3, $4, 'cash', $5, CASE WHEN $5::text IS NULL THEN NULL ELSE 'waybill' END, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, $6, false) RETURNING *`,
    [customer.id, admin.id, status, total, accounting, accounting ? admin.id : null]
  );
  trackOrder(o.id);
  orderIds.push(o.id);
  for (const [productId, q, price] of lines) {
    await pool.query("INSERT INTO order_items (order_id, product_id, product_name, unit_price_amd, quantity, line_total_amd) VALUES ($1, $2, $3, $4, $5, $6)", [o.id, productId, `P${productId}`, price, q, q * price]);
  }
  return o;
}
const linesOf = async (orderId) => (await pool.query("SELECT id, product_id, quantity::float8 AS quantity FROM order_items WHERE order_id = $1 ORDER BY id", [orderId])).rows;
const orderRow = async (orderId) => (await pool.query("SELECT * FROM orders WHERE id = $1", [orderId])).rows[0];

// ---- 0.3 ------------------------------------------------------------------------------------------------------------------------------
test("0.3 fail, then plan again: a failed delivery comes back to the planner list, the counters and the route builder", async () => {
  const o = await newOrder("packed_stock_out");
  const listed = async () => (await apiRequest("/api/delivery/packed-orders", { cookie: driverCookie })).data.some((x) => x.id === o.id);
  assert.ok(await listed(), "packed, not routed: listed");

  const first = await apiRequest("/api/delivery/routes/plan", { method: "POST", cookie: driverCookie, body: { driver_id: driver.id } });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  routeIds.push(first.data.id);
  assert.ok(first.data.stops.some((s) => s.order_id === o.id));
  assert.ok(!(await listed()), "on an open route: not offered again");

  const failed = await apiRequest(`/api/delivery/orders/${o.id}/fail`, { method: "POST", cookie: driverCookie });
  assert.equal(failed.status, 200);
  assert.equal((await orderRow(o.id)).status, "packed_stock_out");
  assert.ok(await listed(), "after the failed attempt it is waiting to be routed again");
  const home = await apiRequest("/api/delivery/home", { cookie: driverCookie });
  assert.ok(home.data.unrouted_packed >= 1);

  const second = await apiRequest("/api/delivery/routes/plan", { method: "POST", cookie: driverCookie, body: { driver_id: driver.id } });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  routeIds.push(second.data.id);
  assert.ok(second.data.stops.some((s) => s.order_id === o.id), "planned again");
  const failedStop = (await pool.query("SELECT completed_at FROM route_stops WHERE route_id = $1 AND order_id = $2", [first.data.id, o.id])).rows[0];
  const failedAt = failedStop.completed_at.getTime();

  // delivered on the new route: only the open stop is closed (the failed attempt keeps its own time), and it is no longer listed
  await pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [o.id]);
  await pool.query("UPDATE route_stops SET completed_at = now() WHERE order_id = $1 AND completed_at IS NULL", [o.id]);
  assert.ok(!(await listed()));
  assert.equal((await pool.query("SELECT completed_at FROM route_stops WHERE route_id = $1 AND order_id = $2", [first.data.id, o.id])).rows[0].completed_at.getTime(), failedAt);
});

// ---- 0.4 ------------------------------------------------------------------------------------------------------------------------------
test("0.4 return, correct, return again: line ids survive a correction, returned goods stay returned, a correction cannot go below them", async () => {
  const o = await newOrder("delivered", { lines: [[p1.id, 3, 9000]] });
  const [line] = await linesOf(o.id);
  const ret = await apiRequest("/api/returns", { method: "POST", cookie: adminCookie, body: { order_id: o.id, reason: "damaged", items: [{ order_item_id: line.id, quantity: 2 }] } });
  assert.equal(ret.status, 201, JSON.stringify(ret.data));

  // corrected: one filter added, the oil kept -> the oil keeps its line id
  const fixed = await apiRequest(`/api/orders/${o.id}/correct`, { method: "POST", cookie: accCookie, body: { reason: "filters forgotten", items: [{ product_id: p1.id, quantity: 3 }, { product_id: p2.id, quantity: 1 }] } });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.data));
  const after = await linesOf(o.id);
  assert.equal(after.find((l) => l.product_id === p1.id).id, line.id, "the kept product keeps its line");
  assert.equal(after.length, 2);

  const returnable = await apiRequest(`/api/returns/order/${o.id}/returnable`, { cookie: adminCookie });
  const oil = returnable.data.items.find((i) => i.id === line.id);
  assert.deepEqual([oil.returned, oil.left], [2, 1]);
  const again = await apiRequest("/api/returns", { method: "POST", cookie: adminCookie, body: { order_id: o.id, reason: "damaged", items: [{ order_item_id: line.id, quantity: 2 }] } });
  assert.equal(again.status, 409, "only 1 more can come back");

  // a correction may not take the oil below the 2 already returned
  const below = await apiRequest(`/api/orders/${o.id}/correct`, { method: "POST", cookie: accCookie, body: { reason: "typo", items: [{ product_id: p1.id, quantity: 1 }, { product_id: p2.id, quantity: 1 }] } });
  assert.equal(below.status, 409);
  assert.equal(below.data.code, "below_returned");
  assert.equal((await linesOf(o.id)).find((l) => l.product_id === p1.id).quantity, 3, "nothing changed");
  const removed = await apiRequest(`/api/orders/${o.id}/correct`, { method: "POST", cookie: accCookie, body: { reason: "typo", items: [{ product_id: p2.id, quantity: 1 }] } });
  assert.equal(removed.data.code, "below_returned", "nor drop the product");
  // down to exactly what was returned is fine; then nothing of it is returnable
  const exact = await apiRequest(`/api/orders/${o.id}/correct`, { method: "POST", cookie: accCookie, body: { reason: "one was never delivered", items: [{ product_id: p1.id, quantity: 2 }, { product_id: p2.id, quantity: 1 }] } });
  assert.equal(exact.status, 200, JSON.stringify(exact.data));
  assert.equal((await apiRequest(`/api/returns/order/${o.id}/returnable`, { cookie: adminCookie })).data.items.find((i) => i.id === line.id).left, 0);
});

test("0.4 an order corrected the old way (return lines lost their order line) still counts what came back, by product", async () => {
  const o = await newOrder("delivered", { lines: [[p1.id, 3, 9000]] });
  const [line] = await linesOf(o.id);
  const ret = await apiRequest("/api/returns", { method: "POST", cookie: adminCookie, body: { order_id: o.id, reason: "damaged", items: [{ order_item_id: line.id, quantity: 2 }] } });
  assert.equal(ret.status, 201);
  // what the old correction did: every line deleted and inserted again (the return line's order_item_id becomes NULL)
  await pool.query("DELETE FROM order_items WHERE order_id = $1", [o.id]);
  await pool.query("INSERT INTO order_items (order_id, product_id, product_name, unit_price_amd, quantity, line_total_amd) VALUES ($1, $2, 'P1', 9000, 3, 27000)", [o.id, p1.id]);
  const [newLine] = await linesOf(o.id);
  const r = await apiRequest(`/api/returns/order/${o.id}/returnable`, { cookie: adminCookie });
  assert.deepEqual([r.data.items[0].returned, r.data.items[0].left], [2, 1]);
  const again = await apiRequest("/api/returns", { method: "POST", cookie: adminCookie, body: { order_id: o.id, reason: "damaged", items: [{ order_item_id: newLine.id, quantity: 3 }] } });
  assert.equal(again.status, 409, "the same goods are not credited twice");
});

// ---- 0.17 -----------------------------------------------------------------------------------------------------------------------------
test("0.17 a stock issue or an approved cancellation withdraws the waiting request; Lily's queue and claim skip a sent-back order", async () => {
  const inQueue = async (id) => (await lily("/orders")).data.orders.some((x) => x.id === ref(id));
  const confirmed = await newOrder("confirmed", { accounting: "pending" });
  assert.ok(await inQueue(confirmed.id), "a confirmed pending order is in the queue");

  const issue = await apiRequest(`/api/warehouse/orders/${confirmed.id}/stock-issue`, { method: "POST", cookie: warehouseCookie, body: { note: "no stock" } });
  assert.equal(issue.status, 200, JSON.stringify(issue.data));
  const afterIssue = await orderRow(confirmed.id);
  assert.deepEqual([afterIssue.status, afterIssue.accounting_status], ["draft", "cancelled"]);
  assert.ok(!(await inQueue(confirmed.id)));

  // an approved cancellation (the admin decides at once)
  const toCancel = await newOrder("confirmed", { accounting: "needs_attention" });
  const c = await apiRequest("/api/returns", { method: "POST", cookie: adminCookie, body: { order_id: toCancel.id, reason: "changed_mind" } });
  assert.equal(c.data.status, "done", JSON.stringify(c.data));
  assert.equal((await orderRow(toCancel.id)).accounting_status, "cancelled");

  // an order left pending in an old state (sent back before this fix): not listed, not waited on, not claimable
  const stale = await newOrder("draft", { accounting: "pending" });
  assert.ok(!(await inQueue(stale.id)));
  const waitRefs = (await lily("/wait?timeout=1")).data.orders;
  assert.ok(!waitRefs.includes(ref(stale.id)), JSON.stringify(waitRefs));
  const claim = await lily(`/orders/${ref(stale.id)}/claim`, "POST");
  assert.equal(claim.status, 409, JSON.stringify(claim.data));
  assert.equal(claim.data.error?.code ?? claim.data.code, "not_pending", JSON.stringify(claim.data));
  assert.equal((await orderRow(stale.id)).accounting_status, "pending", "nothing was claimed");
  const cancelledOne = await newOrder("delivered", { accounting: "pending" });
  await pool.query("UPDATE orders SET cancelled_at = now() WHERE id = $1", [cancelledOne.id]);
  assert.equal((await lily(`/orders/${ref(cancelledOne.id)}/claim`, "POST")).status, 409);
  // a live one is still claimed as before
  const live = await newOrder("packed_stock_out", { accounting: "pending" });
  assert.equal((await lily(`/orders/${ref(live.id)}/claim`, "POST")).status, 200);
});

test("0.17 a correction after Lily's document: needs attention with the reason, documents kept, line ids stable; before any document: untouched", async () => {
  const docs = [{ hc_doc_number: "W-1", date: "2026-11-28", items: [] }];
  const o = await newOrder("delivered", { lines: [[p1.id, 2, 9000], [p2.id, 1, 3000]], accounting: "waybill_created" });
  const before = await linesOf(o.id);
  await pool.query("UPDATE orders SET accounting_documents = $2::jsonb WHERE id = $1", [o.id, JSON.stringify(docs)]);
  const r = await apiRequest(`/api/orders/${o.id}/correct`, { method: "POST", cookie: accCookie, body: { reason: "quantity", items: [{ product_id: p1.id, quantity: 3 }, { product_id: p2.id, quantity: 1 }] } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = await orderRow(o.id);
  assert.equal(row.accounting_status, "needs_attention");
  assert.equal(row.accounting_error.code, "order_changed");
  assert.match(row.accounting_error.message, /changed after the document/);
  assert.deepEqual(row.accounting_documents.map((d) => d.hc_doc_number), ["W-1"], "documents kept");
  assert.deepEqual((await linesOf(o.id)).map((l) => l.id), before.map((l) => l.id), "same line ids (Lily's ln_<id>)");

  // a correction that changes nothing does not flag; a pending request is left pending (Lily reads the order as it is when she claims)
  const same = await newOrder("delivered", { accounting: "signed" });
  const s = await apiRequest(`/api/orders/${same.id}/correct`, { method: "POST", cookie: accCookie, body: { reason: "check", items: [{ product_id: p1.id, quantity: 2 }] } });
  assert.equal(s.status, 200);
  assert.equal((await orderRow(same.id)).accounting_status, "signed");
  const pend = await newOrder("delivered", { accounting: "pending" });
  assert.equal((await apiRequest(`/api/orders/${pend.id}/correct`, { method: "POST", cookie: accCookie, body: { reason: "qty", items: [{ product_id: p1.id, quantity: 1 }] } })).status, 200);
  assert.equal((await orderRow(pend.id)).accounting_status, "pending");
});

// ---- 0.18 -----------------------------------------------------------------------------------------------------------------------------
test("0.18 a signed order: the accountant gets 423 on correct, the admin may correct it", async () => {
  const o = await newOrder("delivered");
  await pool.query("UPDATE orders SET signed_at = now() WHERE id = $1", [o.id]);
  const body = { reason: "after signature", items: [{ product_id: p1.id, quantity: 1 }] };
  const denied = await apiRequest(`/api/orders/${o.id}/correct`, { method: "POST", cookie: accCookie, body });
  assert.equal(denied.status, 423);
  assert.equal(denied.data.code, "order_signed_locked");
  assert.equal((await linesOf(o.id))[0].quantity, 2, "nothing changed");
  const ok = await apiRequest(`/api/orders/${o.id}/correct`, { method: "POST", cookie: adminCookie, body });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});
