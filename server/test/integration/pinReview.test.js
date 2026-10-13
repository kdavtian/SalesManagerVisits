// Pin review (server/src/pinReview.js, routes/pinReview.js), refused-check-in evidence, and the rule that a
// sales manager may delete their own order only until management confirms it (routes/orders.js DELETE).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { findPinCluster } from "../../src/pinReview.js";

let rep, rep2, director, admin;
let repCookie, directorCookie, adminCookie;
const created = { customers: [], orders: [] };

test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  rep2 = await createUser("sales_manager");
  director = await createUser("sales_director");
  admin = await createUser("admin");
  repCookie = await loginAs(rep.email);
  directorCookie = await loginAs(director.email);
  adminCookie = await loginAs(admin.email);
});
test.after(async () => {
  await pool.query("DELETE FROM checkin_far_attempts WHERE user_id = ANY($1)", [[rep.id, rep2.id]]);
  await pool.query("DELETE FROM deleted_orders_log WHERE order_user_id = ANY($1)", [[rep.id, rep2.id]]);
  await cleanupAll();
  await stopTestServer();
});

const customerAt = async (lat, lng) => {
  const c = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, lat, lng });
  created.customers.push(c.id);
  return c;
};
const farCheckin = (customerId, userId, lat, lng, minutesAgo, distance = 800) =>
  pool.query(
    `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range, outcomes)
     VALUES ($1, $2, now() - ($3 || ' minutes')::interval, $4, $5, $6, false, '{other}')`,
    [customerId, userId, String(minutesAgo), lat, lng, distance]
  );

test("findPinCluster: needs 2+ points within 60 m; double taps of one rep are one visit", () => {
  const at = Date.now();
  const p = (user_id, lat, lng, mins) => ({ user_id, lat, lng, at: at - mins * 60000 });
  assert.equal(findPinCluster([p(1, 40.18, 44.51, 0)]), null);
  assert.equal(findPinCluster([p(1, 40.18, 44.51, 0), p(1, 40.18, 44.51, 1)]), null, "same rep within 5 minutes = one visit");
  assert.equal(findPinCluster([p(1, 40.18, 44.51, 0), p(1, 40.19, 44.52, 600)]), null, "far apart");
  const c = findPinCluster([p(1, 40.18, 44.51, 0), p(2, 40.18003, 44.51003, 30), p(1, 40.3, 44.7, 90)]);
  assert.equal(c.points, 2);
  assert.equal(c.users, 2);
  assert.ok(Math.abs(c.lat - 40.180015) < 1e-5);
});

test("Pin review lists a pin with 2+ far check-ins from one spot; Move pin fixes it; the list is for management only", async () => {
  const c = await customerAt(40.18, 44.51);
  // reps really stand ~600 m east of the pin
  await farCheckin(c.id, rep.id, 40.1802, 44.5171, 600);
  await farCheckin(c.id, rep.id, 40.18022, 44.51712, 60 * 24);
  const list = await apiRequest("/api/pin-review", { cookie: directorCookie });
  assert.equal(list.status, 200);
  const row = list.data.find((r) => r.customer_id === c.id);
  assert.ok(row, "flagged");
  assert.equal(row.points, 2);
  assert.ok(row.shift_m > 400 && row.shift_m < 800);
  assert.equal((await apiRequest("/api/pin-review", { cookie: repCookie })).status, 403);

  const accept = await apiRequest(`/api/pin-review/${c.id}/accept`, { method: "POST", cookie: directorCookie, body: {} });
  assert.equal(accept.status, 200);
  const { rows } = await pool.query("SELECT lat, lng, pin_set_at FROM customers WHERE id = $1", [c.id]);
  assert.ok(Math.abs(rows[0].lat - 40.18021) < 1e-4);
  assert.ok(rows[0].pin_set_at, "the trigger recorded when the pin moved");
  const { rows: audit } = await pool.query("SELECT status, note FROM customer_edit_requests WHERE customer_id = $1", [c.id]);
  assert.equal(audit[0].status, "approved");
  assert.match(audit[0].note, /^Pin review/);
  const after = await apiRequest("/api/pin-review", { cookie: directorCookie });
  assert.ok(!after.data.some((r) => r.customer_id === c.id), "old check-ins say nothing about the new pin");
});

test("Pin review: one far check-in, scattered ones, or mixed evidence (reps also check in at the pin) are not flagged; Dismiss hides", async () => {
  const one = await customerAt(40.2, 44.5);
  await farCheckin(one.id, rep.id, 40.2005, 44.508, 100);
  const scattered = await customerAt(40.21, 44.5);
  await farCheckin(scattered.id, rep.id, 40.2105, 44.508, 100);
  await farCheckin(scattered.id, rep.id, 40.2205, 44.52, 5000);
  const mixed = await customerAt(40.22, 44.5);
  await farCheckin(mixed.id, rep.id, 40.2205, 44.508, 100);
  await farCheckin(mixed.id, rep.id, 40.22052, 44.50802, 3000);
  await pool.query(
    `INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range, outcomes)
     VALUES ($1, $2, now() - interval '10 minutes', 40.22, 44.5, 5, true, '{other}'), ($1, $2, now() - interval '9 days', 40.22, 44.5, 5, true, '{other}')`,
    [mixed.id, rep.id]
  );
  const dismissable = await customerAt(40.23, 44.5);
  await farCheckin(dismissable.id, rep.id, 40.2305, 44.508, 100);
  await farCheckin(dismissable.id, rep2.id, 40.23052, 44.50802, 3000);
  // a director's far check-in is never evidence
  const byDirector = await customerAt(40.24, 44.5);
  await farCheckin(byDirector.id, director.id, 40.2405, 44.508, 100);
  await farCheckin(byDirector.id, director.id, 40.24052, 44.50802, 3000);

  const ids = (await apiRequest("/api/pin-review", { cookie: adminCookie })).data.map((r) => r.customer_id);
  for (const c of [one, scattered, mixed, byDirector]) assert.ok(!ids.includes(c.id), `customer ${c.id} must not be flagged`);
  assert.ok(ids.includes(dismissable.id));
  const row = (await apiRequest("/api/pin-review", { cookie: adminCookie })).data.find((r) => r.customer_id === dismissable.id);
  assert.equal(row.users, 2);
  assert.equal(row.confidence, "high");

  await apiRequest(`/api/pin-review/${dismissable.id}/dismiss`, { method: "POST", cookie: adminCookie, body: {} });
  const after = (await apiRequest("/api/pin-review", { cookie: adminCookie })).data.map((r) => r.customer_id);
  assert.ok(!after.includes(dismissable.id));
});

test("POST /api/checkins/far-attempt records where a refused rep stood (once per 5 minutes) and feeds the Pin review", async () => {
  const c = await customerAt(40.25, 44.5);
  const body = { customer_id: c.id, lat: 40.2506, lng: 44.5085, accuracy_m: 12 };
  assert.equal((await apiRequest("/api/checkins/far-attempt", { method: "POST", cookie: repCookie, body })).status, 204);
  assert.equal((await apiRequest("/api/checkins/far-attempt", { method: "POST", cookie: repCookie, body })).status, 204); // deduplicated
  // near the pin: not far, nothing recorded
  await apiRequest("/api/checkins/far-attempt", { method: "POST", cookie: repCookie, body: { customer_id: c.id, lat: 40.25, lng: 44.5 } });
  const { rows } = await pool.query("SELECT accuracy_m FROM checkin_far_attempts WHERE customer_id = $1", [c.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accuracy_m, 12);
  // a second rep stands at the same spot -> flagged
  const cookie2 = await loginAs(rep2.email);
  await apiRequest("/api/checkins/far-attempt", { method: "POST", cookie: cookie2, body: { ...body, lat: 40.25061, lng: 44.50851 } });
  const flagged = (await apiRequest("/api/pin-review", { cookie: directorCookie })).data.find((r) => r.customer_id === c.id);
  assert.ok(flagged);
  assert.equal(flagged.users, 2);
  // the spots page shows the refused attempts too, flagged
  const spots = await apiRequest(`/api/customers/${c.id}/checkin-spots`, { cookie: directorCookie });
  assert.ok(spots.data.spots.some((s) => s.attempt === true));
});

test("a poor GPS fix (accuracy > 100 m) is not evidence", async () => {
  const c = await customerAt(40.26, 44.5);
  for (const lng of [44.5085, 44.50851]) {
    await pool.query(
      `INSERT INTO checkin_far_attempts (customer_id, user_id, lat, lng, distance_meters, accuracy_m, created_at)
       VALUES ($1, $2, 40.2606, $3, 700, 250, now() - ($4 || ' minutes')::interval)`,
      [c.id, rep.id, lng, String(lng === 44.5085 ? 10 : 90)]
    );
  }
  const ids = (await apiRequest("/api/pin-review", { cookie: directorCookie })).data.map((r) => r.customer_id);
  assert.ok(!ids.includes(c.id));
});

// --- order delete ---------------------------------------------------------------

const order = async (userId, status) => {
  const c = await createCustomer({ created_by: director.id, assigned_manager_id: userId });
  created.customers.push(c.id);
  const { rows } = await pool.query("INSERT INTO orders (customer_id, user_id, status, total_amd) VALUES ($1, $2, $3, 5000) RETURNING id", [c.id, userId, status]);
  await pool.query("INSERT INTO order_items (order_id, product_name, unit_price_amd, quantity, line_total_amd) VALUES ($1, 'Test oil', 5000, 1, 5000)", [rows[0].id]);
  created.orders.push(rows[0].id);
  return rows[0].id;
};

test("DELETE /api/orders/:id: a rep deletes their OWN draft/submitted order; confirmed, someone else's, or a director's attempt is refused", async () => {
  const draft = await order(rep.id, "draft");
  const submitted = await order(rep.id, "submitted");
  const confirmed = await order(rep.id, "confirmed");
  const others = await order(rep2.id, "submitted");

  assert.equal((await apiRequest(`/api/orders/${draft}`, { method: "DELETE", cookie: repCookie })).status, 204);
  assert.equal((await apiRequest(`/api/orders/${submitted}`, { method: "DELETE", cookie: repCookie })).status, 204);
  const gone = await pool.query("SELECT 1 FROM orders WHERE id = ANY($1)", [[draft, submitted]]);
  assert.equal(gone.rows.length, 0);
  const log = await pool.query("SELECT order_id, status, total_amd, items, deleted_by FROM deleted_orders_log WHERE order_id = ANY($1) ORDER BY order_id", [[draft, submitted]]);
  assert.equal(log.rows.length, 2);
  assert.equal(log.rows[1].status, "submitted");
  assert.equal(log.rows[1].deleted_by, rep.id);
  assert.equal(log.rows[1].items[0].product_name, "Test oil");

  const approved = await apiRequest(`/api/orders/${confirmed}`, { method: "DELETE", cookie: repCookie });
  assert.equal(approved.status, 403);
  assert.match(approved.data.error, /already approved by management/);
  assert.equal((await apiRequest(`/api/orders/${others}`, { method: "DELETE", cookie: repCookie })).status, 403);
  assert.equal((await apiRequest(`/api/orders/${others}`, { method: "DELETE", cookie: directorCookie })).status, 403);
  // admin still deletes any order, and it is logged too
  assert.equal((await apiRequest(`/api/orders/${confirmed}`, { method: "DELETE", cookie: adminCookie })).status, 204);
  assert.equal((await pool.query("SELECT 1 FROM deleted_orders_log WHERE order_id = $1", [confirmed])).rows.length, 1);
  assert.equal((await apiRequest(`/api/orders/${others}`, { method: "DELETE", cookie: adminCookie })).status, 204);
});
