// Visit priorities, "End visit", the weekly scorecard and the new-customer pipeline.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { weekRange } from "../../src/scorecard.js";

let users;
let cookies;
const erpIds = [];
const stamp = Date.now();

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "sales_director", "sales_manager", "accountant"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
});
test.after(async () => {
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [erpIds]);
  await cleanupAll();
  await stopTestServer();
});

const checkin = async (customer, withinRange = true, ago = "0 days", userId = users.sales_manager.id) =>
  (await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, timestamp)
     VALUES ($1, $2, 40.18, 44.51, $3, $4, now() - $5::interval) RETURNING id`,
    [customer.id, userId, withinRange ? 5 : 5000, withinRange, ago]
  )).rows[0].id;

test("weekRange gives Monday to next Monday", () => {
  assert.deepEqual(weekRange("2026-10-10"), { from: "2026-10-05", to: "2026-10-12" }); // Saturday
  assert.deepEqual(weekRange("2026-10-05"), { from: "2026-10-05", to: "2026-10-12" }); // Monday
  assert.deepEqual(weekRange("2026-10-11"), { from: "2026-10-05", to: "2026-10-12" }); // Sunday
});

test("visit priorities: overdue debt first, visited-today customers left out, only sales managers get a list", async () => {
  const erpId = `ITEST-BR3-${stamp}`;
  erpIds.push(erpId);
  const debtor = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: users.sales_manager.id, erp_customer_id: erpId, name: "Priority Debtor" });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, days_since_payment, synced_at) VALUES ($1, 'x', 900000, 80, now())", [erpId]);
  const stale = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: users.sales_manager.id, name: "Priority Stale" });
  await checkin(stale, true, "20 days");
  const done = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: users.sales_manager.id, name: "Priority Done Today" });
  await pool.query("UPDATE customers SET visit_frequency_days = 1 WHERE id = $1", [done.id]);
  await checkin(done, true, "0 days");
  const outOfRange = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: users.sales_manager.id, name: "Priority Far" });
  await checkin(outOfRange, false, "0 days");

  const res = await apiRequest("/api/customers/visit-priorities", { cookie: cookies.sales_manager });
  assert.equal(res.status, 200);
  const ids = res.data.map((r) => r.customer_id);
  assert.equal(ids[0], debtor.id, "overdue debt ranks first");
  assert.ok(res.data[0].reasons.some((r) => r.type === "debt" && r.amount === 900000));
  assert.ok(ids.includes(stale.id));
  assert.ok(!ids.includes(done.id), "visited today is left out");
  assert.ok(ids.includes(outOfRange.id), "an out-of-range check-in is not a visit");
  assert.deepEqual((await apiRequest("/api/customers/visit-priorities", { cookie: cookies.admin })).data, []);
});

test("End visit: only the own open check-in of today, once", async () => {
  const customer = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: users.sales_manager.id });
  const id = await checkin(customer, true, "10 minutes");
  const open = await apiRequest(`/api/checkins/open?customer_id=${customer.id}`, { cookie: cookies.sales_manager });
  assert.equal(open.data.id, id);
  assert.equal((await apiRequest(`/api/checkins/${id}/end`, { method: "POST", cookie: cookies.admin })).status, 404, "not someone else's visit");
  const ended = await apiRequest(`/api/checkins/${id}/end`, { method: "POST", cookie: cookies.sales_manager });
  assert.equal(ended.status, 200);
  assert.equal((await apiRequest(`/api/checkins/${id}/end`, { method: "POST", cookie: cookies.sales_manager })).status, 404, "only once");
  assert.equal((await apiRequest(`/api/checkins/open?customer_id=${customer.id}`, { cookie: cookies.sales_manager })).data, null);
});

test("weekly scorecard: counts in-range visits, orders, conversion and visit length; a rep sees only their own row", async () => {
  // A fresh rep, so the other tests' check-ins do not count.
  const rep = await createUser("sales_manager");
  const repCookie = await loginAs(rep.email);
  const erpId = `ITEST-BR3-SC-${stamp}`;
  erpIds.push(erpId);
  const customer = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: rep.id, erp_customer_id: erpId });
  const other = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: rep.id });
  const product = await createProduct({ unit_price_amd: 1000 });
  const id = await checkin(customer, true, "0 days", rep.id);
  await pool.query("UPDATE checkins SET ended_at = timestamp + interval '30 minutes' WHERE id = $1", [id]);
  await checkin(other, true, "0 days", rep.id);
  await checkin(other, false, "0 days", rep.id); // out of range: not counted
  const o = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 5 }], payment_method: "cash" } });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  trackOrder(o.data.id);

  const res = await apiRequest("/api/biz-reports/scorecard", { cookie: cookies.sales_director });
  assert.equal(res.status, 200);
  const row = res.data.reps.find((r) => r.id === rep.id);
  assert.equal(row.visits, 2);
  assert.equal(row.customers_visited, 2);
  assert.equal(row.orders, 1);
  assert.equal(row.orders_amd, 5000);
  assert.equal(row.visited_and_ordered, 1);
  assert.equal(row.conversion_pct, 50);
  assert.equal(row.avg_visit_minutes, 30);
  const own = await apiRequest("/api/biz-reports/scorecard", { cookie: repCookie });
  assert.equal(own.data.reps.length, 1);
  assert.equal(own.data.reps[0].id, rep.id);
  assert.equal((await apiRequest("/api/biz-reports/scorecard", { cookie: cookies.accountant })).status, 403);
});

test("customer pipeline lists customers without an ERP id, oldest first, for the accountant", async () => {
  const waiting = await createCustomer({ created_by: users.sales_manager.id, assigned_manager_id: users.sales_manager.id, name: "Pipeline Waiting" });
  await pool.query("UPDATE customers SET created_at = now() - interval '5 days' WHERE id = $1", [waiting.id]);
  const res = await apiRequest("/api/biz-reports/pipeline", { cookie: cookies.accountant });
  assert.equal(res.status, 200);
  const row = res.data.waiting.find((r) => r.id === waiting.id);
  assert.ok(row && row.age_days >= 5);
  assert.ok(res.data.funnel.created >= 1);
  assert.equal((await apiRequest("/api/biz-reports/pipeline", { cookie: cookies.sales_manager })).status, 403);
});

test("delivery speed: hours from confirmed to packed to delivered, by hand vs Excel, and orders waiting now", async () => {
  const customer = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: users.sales_manager.id, name: "Speed Customer" });
  const product = await createProduct({ unit_price_amd: 1000 });
  const mk = async () => {
    const o = await apiRequest("/api/orders", { method: "POST", cookie: cookies.sales_manager, body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash" } });
    trackOrder(o.data.id);
    return o.data.id;
  };
  const hist = (id, from, to, ago) =>
    pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1, $2, $3, now() - $4::interval)", [id, from, to, ago]);
  // Delivered by hand: confirmed 30 h ago, packed 24 h ago, delivered 6 h ago -> pack 6 h, deliver 18 h, total 24 h.
  const done = await mk();
  await pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [done]);
  await hist(done, "submitted", "confirmed", "30 hours");
  await hist(done, "confirmed", "packed_stock_out", "24 hours");
  await hist(done, "packed_stock_out", "delivered", "6 hours");
  // Delivered via Excel.
  const viaExcel = await mk();
  await pool.query("UPDATE orders SET status = 'delivered', delivered_from_erp = true WHERE id = $1", [viaExcel]);
  await hist(viaExcel, "submitted", "confirmed", "80 hours");
  await hist(viaExcel, "confirmed", "packed_stock_out", "78 hours");
  await hist(viaExcel, "packed_stock_out", "delivered", "1 hours");
  // Still waiting: confirmed 50 h ago, never packed.
  const waiting = await mk();
  await pool.query("UPDATE orders SET status = 'confirmed' WHERE id = $1", [waiting]);
  await hist(waiting, "submitted", "confirmed", "50 hours");

  const res = await apiRequest("/api/biz-reports/delivery-speed?days=30", { cookie: cookies.sales_director });
  assert.equal(res.status, 200);
  assert.ok(res.data.delivered >= 2);
  assert.ok(res.data.deliver_by_hand.n >= 1 && res.data.deliver_from_excel.n >= 1);
  const slow = res.data.slowest.find((r) => r.id === viaExcel);
  assert.ok(slow && slow.from_excel === true && Math.round(slow.total_hours) === 79);
  const wait = res.data.open.find((r) => r.id === waiting);
  assert.ok(wait && Math.round(wait.waiting_hours) === 50 && wait.status === "confirmed");
  assert.equal((await apiRequest("/api/biz-reports/delivery-speed", { cookie: cookies.accountant })).status, 403);
});
