// Signed accounting documents (owner, 2026-10-27): the warehouse and the drivers open only those of orders placed in the last two weeks;
// every other role sees them all, as on the customer card.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

test.before(startTestServer);
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("the warehouse and drivers open only the documents of orders from the last two weeks; other roles see them all", async () => {
  const director = await createUser("sales_director");
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: director.id });
  const order = async (daysAgo) =>
    trackOrder(
      (await pool.query("INSERT INTO orders (customer_id, user_id, status, total_amd, created_at) VALUES ($1, $2, 'confirmed', 1000, now() - $3::int * interval '1 day') RETURNING id", [customer.id, director.id, daysAgo])).rows[0].id
    );
  const pdf = Buffer.from("%PDF-1.4\n%itest\n");
  const doc = async (orderId) =>
    (await pool.query("INSERT INTO order_documents (order_id, filename, size_bytes, data) VALUES ($1, 'w.pdf', $2, $3) RETURNING id", [orderId, pdf.length, pdf])).rows[0].id;
  const fresh = await doc(await order(3));
  const old = await doc(await order(20));

  for (const role of ["warehouse_manager", "delivery_manager"]) {
    const cookie = await loginAs((await createUser(role)).email);
    const listed = (await apiRequest(`/api/customers/${customer.id}/documents`, { cookie })).data.map((d) => d.id);
    assert.deepEqual(listed, [fresh], `${role}: only the recent order's document is listed`);
    assert.equal((await apiRequest(`/api/orders/documents/${fresh}/file`, { cookie })).status, 200);
    assert.equal((await apiRequest(`/api/orders/documents/${old}/file`, { cookie })).status, 403);
    assert.equal((await apiRequest(`/api/orders/documents/${old}/preview`, { cookie })).status, 403);
  }
  const cookie = await loginAs(director.email);
  const all = (await apiRequest(`/api/customers/${customer.id}/documents`, { cookie })).data.map((d) => d.id).sort((a, b) => a - b);
  assert.deepEqual(all, [fresh, old].sort((a, b) => a - b), "a director sees both");
  assert.equal((await apiRequest(`/api/orders/documents/${old}/file`, { cookie })).status, 200);
});
