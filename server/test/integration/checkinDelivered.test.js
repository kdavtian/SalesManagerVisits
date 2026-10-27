// "Products delivered" on a check-in: the rep picks the customer's CONFIRMED / PACKED orders and they move to Delivered on submit.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, apiFormRequest, loginAs, trackOrder, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { parseDeliveredOrderIds } from "../../src/checkinDelivery.js";

let rep, repCookie, director, directorCookie, customer, other, product;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  director = await createUser("sales_director");
  repCookie = await loginAs(rep.email);
  directorCookie = await loginAs(director.email);
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `CD-${Date.now()}` });
  other = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `CD2-${Date.now()}` });
  product = await createProduct({ unit: "4L" });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const newOrder = async (customerId) => {
  const res = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: customerId, payment_method: "invoice", items: [{ product_id: product.id, quantity: 2 }] } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackOrder(res.data.id);
  return res.data.id;
};
// "Packed" is the warehouse's own step (not in the generic PATCH), so the test sets it directly.
const setStatus = async (id, status) => {
  if (status === "packed_stock_out") return void (await pool.query("UPDATE orders SET status = 'packed_stock_out' WHERE id = $1", [id]));
  assert.equal((await apiRequest(`/api/orders/${id}`, { method: "PATCH", cookie: directorCookie, body: { status } })).status, 200);
};

const checkin = (customerId, fields) => {
  const form = new FormData();
  form.set("customer_id", customerId);
  form.set("lat", "40.18");
  form.set("lng", "44.51");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return apiFormRequest("/api/checkins", { cookie: repCookie, form });
};

test("parseDeliveredOrderIds keeps positive unique integers only", () => {
  assert.deepEqual(parseDeliveredOrderIds("[3, 3, 5, -1, 0, \"x\", 2.5]"), [3, 5]);
  assert.deepEqual(parseDeliveredOrderIds("nope"), []);
  assert.deepEqual(parseDeliveredOrderIds(undefined), []);
});

test("the list offers only this customer's confirmed and packed orders", async () => {
  const submitted = await newOrder(customer.id);
  const confirmed = await newOrder(customer.id);
  const packed = await newOrder(customer.id);
  const foreign = await newOrder(other.id);
  await setStatus(confirmed, "confirmed");
  await setStatus(packed, "confirmed");
  await setStatus(packed, "packed_stock_out");
  await setStatus(foreign, "confirmed");
  const res = await apiRequest(`/api/checkins/deliverable-orders?customer_id=${customer.id}`, { cookie: repCookie });
  assert.equal(res.status, 200);
  const ids = res.data.map((o) => o.id);
  assert.deepEqual(ids, [confirmed, packed]);
  assert.ok(!ids.includes(submitted) && !ids.includes(foreign));
  assert.equal(res.data[0].unit_count, 2);
  assert.equal((await apiRequest("/api/checkins/deliverable-orders", { cookie: repCookie })).status, 400);
});

test("submitting the check-in moves the picked orders to Delivered (history written); a stale or foreign pick is skipped", async () => {
  const a = await newOrder(customer.id);
  const b = await newOrder(customer.id);
  const foreign = await newOrder(other.id);
  await setStatus(a, "confirmed");
  await setStatus(b, "confirmed");
  await setStatus(b, "packed_stock_out");
  await setStatus(foreign, "confirmed");
  const res = await checkin(customer.id, { outcomes: JSON.stringify(["customer_unavailable"]), delivered_order_ids: JSON.stringify([a, b, foreign, 999999999]) });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackCheckin(res.data.id);
  assert.deepEqual(res.data.delivered_orders.map((o) => o.id).sort((x, y) => x - y), [a, b].sort((x, y) => x - y));
  const { rows } = await pool.query("SELECT id, status FROM orders WHERE id = ANY($1)", [[a, b, foreign]]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
  assert.equal(byId[a], "delivered");
  assert.equal(byId[b], "delivered");
  assert.equal(byId[foreign], "confirmed", "another customer's order is never touched");
  const detail = await apiRequest(`/api/orders/${a}`, { cookie: directorCookie });
  assert.ok(detail.data.history.some((h) => h.old_status === "confirmed" && h.new_status === "delivered" && /check-in/i.test(h.reason)));
  // the visit details link "Products delivered" to these orders, in Activity and on the customer card (owner, 2026-10-27)
  const sorted = [a, b].sort((x, y) => x - y);
  const listed = (await apiRequest(`/api/checkins?customer_id=${customer.id}`, { cookie: directorCookie })).data.rows.find((c) => c.id === res.data.id);
  assert.deepEqual(listed.delivered_order_ids, sorted);
  const onCard = (await apiRequest(`/api/customers/${customer.id}/checkins?limit=30`, { cookie: directorCookie })).data.find((c) => c.id === res.data.id);
  assert.deepEqual(onCard.delivered_order_ids, sorted);
});

test("a retried check-in (same client_ref) does not deliver twice; picking nothing is fine; ids are ignored without the outcome", async () => {
  const a = await newOrder(customer.id);
  const c = await newOrder(customer.id);
  await setStatus(a, "confirmed");
  await setStatus(c, "confirmed");
  const ref = `deliv-${Date.now()}`;
  const first = await checkin(customer.id, { outcomes: JSON.stringify(["customer_unavailable"]), delivered_order_ids: JSON.stringify([a]), client_ref: ref });
  assert.equal(first.status, 201);
  trackCheckin(first.data.id);
  const again = await checkin(customer.id, { outcomes: JSON.stringify(["customer_unavailable"]), delivered_order_ids: JSON.stringify([a]), client_ref: ref });
  assert.equal(again.status, 201);
  assert.equal(again.data.id, first.data.id);
  const none = await checkin(customer.id, { outcomes: JSON.stringify(["customer_unavailable"]) });
  assert.equal(none.status, 201);
  trackCheckin(none.data.id);
  assert.deepEqual(none.data.delivered_orders, []);
  const wrongOutcome = await checkin(customer.id, { outcomes: JSON.stringify(["no_order"]), delivered_order_ids: JSON.stringify([c]) });
  assert.equal(wrongOutcome.status, 201);
  trackCheckin(wrongOutcome.data.id);
  const { rows } = await pool.query("SELECT status FROM orders WHERE id = $1", [c]);
  assert.equal(rows[0].status, "confirmed", "ids without the Products delivered outcome do nothing");
});
