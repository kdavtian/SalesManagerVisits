// The warehouse manager's and the driver's new Home screens (owner, 2026-10-23): numbers + what is going wrong.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let rep, wm, driver, repCookie, wmCookie, driverCookie, customer, product;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  wm = await createUser("warehouse_manager");
  driver = await createUser("delivery_manager");
  repCookie = await loginAs(rep.email);
  wmCookie = await loginAs(wm.email);
  driverCookie = await loginAs(driver.email);
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, lat: 40.2, lng: 44.5, erp_customer_id: `OH-${Date.now()}` });
  product = await createProduct({ unit: "4L" });
  await pool.query("UPDATE products SET stock_qty = 2 WHERE id = $1", [product.id]);
});
test.after(async () => {
  await pool.query("DELETE FROM delivery_routes WHERE driver_id = $1", [driver.id]);
  await cleanupAll();
  await stopTestServer();
});

async function order(status, quantity = 1) {
  const res = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, payment_method: "invoice", items: [{ product_id: product.id, quantity }] } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackOrder(res.data.id);
  if (status !== "submitted") await pool.query("UPDATE orders SET status = $2 WHERE id = $1", [res.data.id, status]);
  return res.data.id;
}

test("warehouse home: only the warehouse roles; counts what waits and what is short", async () => {
  assert.equal((await apiRequest("/api/warehouse/home", { cookie: repCookie })).status, 403);
  const before = (await apiRequest("/api/warehouse/home", { cookie: wmCookie })).data;
  assert.equal((await apiRequest("/api/warehouse/home", { cookie: wmCookie })).status, 200);
  const toPack = await order("confirmed", 5); // needs 5 of a product that has 2
  await pool.query("UPDATE orders SET placed_via_app = true WHERE id = $1", [toPack]);
  const packedId = await order("packed_stock_out");
  const after = (await apiRequest("/api/warehouse/home", { cookie: wmCookie })).data;
  assert.equal(after.to_pack.count, before.to_pack.count + 1);
  assert.equal(after.to_pack.app, before.to_pack.app + 1);
  assert.equal(after.packed.count, before.packed.count + 1);
  assert.equal(after.packed.unrouted, before.packed.unrouted + 1);
  assert.ok(after.shortage.products >= 1);
  const row = after.shortage.sample.find((r) => r.have === 2 && r.need >= 5);
  assert.ok(row, "the short product is named with what is needed and what is in stock");
  assert.ok(typeof after.tasks.open === "number" && typeof after.today.stops === "number" && typeof after.stale_stops === "number");
  // a packed order on a route is no longer "unrouted"
  const { rows } = await pool.query("INSERT INTO delivery_routes (driver_id, route_date, created_by) VALUES ($1, (now() AT TIME ZONE 'Asia/Yerevan')::date, $1) RETURNING id", [driver.id]);
  await pool.query("INSERT INTO route_stops (route_id, order_id, sequence) VALUES ($1, $2, 1)", [rows[0].id, packedId]);
  const routed = (await apiRequest("/api/warehouse/home", { cookie: wmCookie })).data;
  assert.equal(routed.packed.unrouted, before.packed.unrouted);
  assert.equal(routed.today.stops, before.today.stops + 1);
});

test("driver home: today's stops, next one first; others cannot read it", async () => {
  assert.equal((await apiRequest("/api/delivery/home", { cookie: repCookie })).status, 403);
  assert.equal((await apiRequest("/api/delivery/home", { cookie: wmCookie })).status, 403);
  const res = await apiRequest("/api/delivery/home", { cookie: driverCookie });
  assert.equal(res.status, 200);
  assert.ok(res.data.total >= 1);
  assert.equal(res.data.done, 0);
  assert.equal(res.data.next.customer_id, customer.id);
  assert.ok(res.data.next.address !== undefined && "phone" in res.data.next);
  assert.equal(typeof res.data.unrouted_packed, "number");
  // after the stop is completed the next stop moves on
  await pool.query("UPDATE route_stops SET completed_at = now() WHERE route_id IN (SELECT id FROM delivery_routes WHERE driver_id = $1)", [driver.id]);
  const done = (await apiRequest("/api/delivery/home", { cookie: driverCookie })).data;
  assert.equal(done.done, done.total);
  assert.equal(done.next, null);
});
