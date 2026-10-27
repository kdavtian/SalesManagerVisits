// Owner, 2026-10-27: "if the user chose Order placed at check-in and later adds a new order from the Orders page for the same customer,
// link them together", so the visit's details open that order. The link is the existing orders.checkin_id; without one from the client
// the server picks the rep's own "Order placed" visit of this customer today that has no order yet.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

test.before(startTestServer);
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("an order typed later from Orders links to today's 'Order placed' visit; only the rep's own, only once, never a visit without that outcome", async () => {
  const rep = await createUser("sales_manager");
  const other = await createUser("sales_manager");
  const customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  const product = await createProduct({ unit_price_amd: 1000 });
  const cookie = await loginAs(rep.email);
  const checkin = async (userId, outcomes, hoursAgo = 1) => {
    const { rows } = await pool.query(
      "INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, timestamp) VALUES ($1, $2, 40.18, 44.5, 5, true, $3, now() - ($4 || ' hours')::interval) RETURNING id",
      [customer.id, userId, outcomes, hoursAgo]
    );
    trackCheckin(rows[0].id);
    return rows[0].id;
  };
  const order = async () => {
    const res = await apiRequest("/api/orders", { method: "POST", cookie, body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash" } });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    trackOrder(res.data.id);
    return res.data;
  };

  // a visit without "Order placed" and another rep's visit are never linked
  await checkin(rep.id, ["follow_up_required"], 3);
  await checkin(other.id, ["order_placed"], 2);
  const o1 = await order();
  assert.equal(o1.checkin_id, null);

  // the rep's own "Order placed" visit of today -> the next order links to it; the one after that does not (one order per visit)
  const visit = await checkin(rep.id, ["order_placed"], 1);
  const o2 = await order();
  assert.equal(o2.checkin_id, visit);
  const o3 = await order();
  assert.equal(o3.checkin_id, null);
  const { rows } = await pool.query("SELECT (SELECT o.id FROM orders o WHERE o.checkin_id = ch.id) AS order_id FROM checkins ch WHERE ch.id = $1", [visit]);
  assert.equal(rows[0].order_id, o2.id);
});
