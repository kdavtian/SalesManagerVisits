// Driver arrival (owner, 2026-10-23): off / suggest (one tap) / auto; radius + dwell; a drive-by resets the clock.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { normalizeArrivalSettings, validateArrivalPatch, ARRIVAL_DEFAULTS } from "../../src/orders/driverArrival.js";

let rep, driver, admin, repCookie, driverCookie, adminCookie, customer, product, routeId;
const HERE = { lat: 40.2, lng: 44.5 };
// ~0.001 deg of latitude = 111 m
const NEAR = { lat: HERE.lat + 0.0003, lng: HERE.lng, accuracy: 10 }; // ~33 m
const FAR = { lat: HERE.lat + 0.01, lng: HERE.lng, accuracy: 10 }; // ~1.1 km

test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  driver = await createUser("delivery_manager");
  admin = await createUser("admin");
  repCookie = await loginAs(rep.email);
  driverCookie = await loginAs(driver.email);
  adminCookie = await loginAs(admin.email);
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: HERE.lat, lng: HERE.lng, erp_customer_id: `DA-${Date.now()}` });
  product = await createProduct({ unit: "4L" });
});
test.after(async () => {
  await pool.query("DELETE FROM delivery_routes WHERE driver_id = $1", [driver.id]);
  await pool.query("UPDATE app_settings SET delivery_arrival = NULL WHERE id = 1");
  await cleanupAll();
  await stopTestServer();
});

const setMode = async (patch) => {
  const res = await apiRequest("/api/delivery/arrival-settings", { method: "PUT", cookie: adminCookie, body: patch });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res;
};
const ping = (pos) => apiRequest("/api/delivery/arrival", { method: "POST", cookie: driverCookie, body: pos });

// a packed order on today's route of the driver (reset every test)
async function routeWithPackedOrder(n = 1) {
  await pool.query("DELETE FROM delivery_routes WHERE driver_id = $1", [driver.id]);
  const orderIds = [];
  for (let i = 0; i < n; i++) {
    const res = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, payment_method: "invoice", items: [{ product_id: product.id, quantity: 1 }] } });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    trackOrder(res.data.id);
    await pool.query("UPDATE orders SET status = 'packed_stock_out' WHERE id = $1", [res.data.id]);
    orderIds.push(res.data.id);
  }
  const { rows } = await pool.query("INSERT INTO delivery_routes (driver_id, route_date, created_by) VALUES ($1, (now() AT TIME ZONE 'Asia/Yerevan')::date, $1) RETURNING id", [driver.id]);
  routeId = rows[0].id;
  for (const [i, id] of orderIds.entries()) await pool.query("INSERT INTO route_stops (route_id, order_id, sequence) VALUES ($1, $2, $3)", [routeId, id, i + 1]);
  return orderIds;
}
const status = async (id) => (await pool.query("SELECT status FROM orders WHERE id = $1", [id])).rows[0].status;

test("settings: defaults, validation, only admin / CEO change them", async () => {
  assert.deepEqual(normalizeArrivalSettings(null), ARRIVAL_DEFAULTS);
  assert.equal(normalizeArrivalSettings({ mode: "nope" }).mode, "suggest");
  assert.ok(validateArrivalPatch({ mode: "bad" }).error);
  assert.ok(validateArrivalPatch({ radius_m: 5 }).error);
  assert.ok(validateArrivalPatch({ dwell_seconds: 9999 }).error);
  assert.deepEqual(validateArrivalPatch({ mode: "auto", radius_m: 100 }).value, { mode: "auto", radius_m: 100 });
  assert.equal((await apiRequest("/api/delivery/arrival-settings", { method: "PUT", cookie: driverCookie, body: { mode: "off" } })).status, 403);
  assert.equal((await apiRequest("/api/delivery/arrival-settings", { cookie: repCookie })).status, 403);
  const saved = await setMode({ mode: "suggest", radius_m: 80, dwell_seconds: 0 });
  assert.equal(saved.status, 200);
  assert.equal((await apiRequest("/api/delivery/arrival-settings", { cookie: driverCookie })).data.dwell_seconds, 0);
});

test("only a driver reports a position", async () => {
  assert.equal((await apiRequest("/api/delivery/arrival", { method: "POST", cookie: repCookie, body: NEAR })).status, 403);
  assert.equal((await apiRequest("/api/delivery/arrival", { method: "POST", cookie: driverCookie, body: { lat: "x" } })).status, 400);
});

test("mode off: nothing is detected and nothing is stored", async () => {
  await setMode({ mode: "off" });
  const [id] = await routeWithPackedOrder();
  const res = await ping(NEAR);
  assert.deepEqual(res.data, { mode: "off", arrival: null });
  assert.equal((await pool.query("SELECT arrived_at FROM route_stops WHERE order_id = $1", [id])).rows[0].arrived_at, null);
});

test("suggest: arriving offers the orders, nothing is delivered until the one tap", async () => {
  await setMode({ mode: "suggest", radius_m: 80, dwell_seconds: 0 });
  const ids = await routeWithPackedOrder(2);
  const far = await ping(FAR);
  assert.equal(far.data.arrival, null);
  const res = await ping(NEAR);
  assert.equal(res.status, 200);
  assert.equal(res.data.arrival.customer_id, customer.id);
  assert.equal(res.data.arrival.ready, true);
  assert.deepEqual(res.data.arrival.orders.map((o) => o.id).sort(), [...ids].sort());
  assert.deepEqual(res.data.arrival.auto_delivered, []);
  assert.equal(await status(ids[0]), "packed_stock_out");
  // the one tap
  assert.equal((await apiRequest("/api/delivery/arrival/deliver", { method: "POST", cookie: repCookie, body: { customer_id: customer.id } })).status, 403);
  const tap = await apiRequest("/api/delivery/arrival/deliver", { method: "POST", cookie: driverCookie, body: { customer_id: customer.id } });
  assert.equal(tap.status, 200, JSON.stringify(tap.data));
  assert.equal(tap.data.delivered.length, 2);
  for (const id of ids) assert.equal(await status(id), "delivered");
  const { rows } = await pool.query("SELECT completed_at, completed_by_arrival FROM route_stops WHERE order_id = ANY($1)", [ids]);
  assert.ok(rows.every((r) => r.completed_at && r.completed_by_arrival === "one_tap"));
  const hist = await apiRequest(`/api/orders/${ids[0]}`, { cookie: adminCookie });
  assert.ok(hist.data.history.some((h) => h.new_status === "delivered" && /one tap/i.test(h.reason)));
});

test("one tap needs a real arrival first", async () => {
  await setMode({ mode: "suggest", radius_m: 80, dwell_seconds: 0 });
  const [id] = await routeWithPackedOrder();
  const tap = await apiRequest("/api/delivery/arrival/deliver", { method: "POST", cookie: driverCookie, body: { customer_id: customer.id } });
  assert.equal(tap.status, 404);
  assert.equal(await status(id), "packed_stock_out");
});

test("auto: the orders are delivered by the arrival itself, after the dwell time", async () => {
  await setMode({ mode: "auto", radius_m: 80, dwell_seconds: 600 });
  const [id] = await routeWithPackedOrder();
  const first = await ping(NEAR);
  assert.equal(first.data.arrival.ready, false, "the dwell time has not passed");
  assert.deepEqual(first.data.arrival.auto_delivered, []);
  assert.equal(await status(id), "packed_stock_out");
  // pretend the driver has been standing there for an hour
  await pool.query("UPDATE route_stops SET arrived_at = now() - interval '2 hours' WHERE order_id = $1", [id]);
  const second = await ping(NEAR);
  assert.equal(second.data.arrival.ready, true);
  assert.equal(second.data.arrival.auto_delivered.length, 1);
  assert.equal(await status(id), "delivered");
  assert.equal((await pool.query("SELECT completed_by_arrival FROM route_stops WHERE order_id = $1", [id])).rows[0].completed_by_arrival, "auto");
});

test("a drive-by (left the circle) resets the arrival clock; a coarse GPS fix says nothing", async () => {
  await setMode({ mode: "auto", radius_m: 80, dwell_seconds: 600 });
  const [id] = await routeWithPackedOrder();
  await ping(NEAR);
  assert.ok((await pool.query("SELECT arrived_at FROM route_stops WHERE order_id = $1", [id])).rows[0].arrived_at);
  const coarse = await ping({ ...NEAR, accuracy: 900 });
  assert.equal(coarse.data.weak_gps, true);
  assert.ok((await pool.query("SELECT arrived_at FROM route_stops WHERE order_id = $1", [id])).rows[0].arrived_at, "a coarse fix does not reset it");
  await ping(FAR);
  assert.equal((await pool.query("SELECT arrived_at FROM route_stops WHERE order_id = $1", [id])).rows[0].arrived_at, null);
  assert.equal(await status(id), "packed_stock_out");
});
