// New order screen: the "Frequent" ranking.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createProduct, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let repA, cookieA, p1, p2, p3;
const stamp = Date.now();

test.before(async () => {
  await startTestServer();
  repA = await createUser("sales_manager");
  cookieA = await loginAs(repA.email);
  [p1, p2, p3] = [await createProduct({ unit: "4L" }), await createProduct({ unit: "1L" }), await createProduct({ unit: "208L" })];
  for (const [p, key] of [[p1, "a"], [p2, "b"], [p3, "c"]]) {
    await pool.query("UPDATE products SET erp_product_id = $2 WHERE id = $1", [p.id, `ITEST-FAV-${key}-${stamp}`]);
    p.erp_product_id = `ITEST-FAV-${key}-${stamp}`;
  }
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE order_id LIKE $1", [`FAV-${stamp}-%`]);
  await cleanupAll();
  await stopTestServer();
});

test("frequent: products by number of distinct orders in the last 90 days, internal stock account and old lines ignored", async () => {
  const line = (orderId, erpCustomer, daysBack, product, qty = 1) =>
    pool.query(
      `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, brand, product_name, qty, unit_price_amd, revenue_amd)
       VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Yerevan')::date - $3::int, $4, 'Castrol', 'x', $5, 1000, 1000)`,
      [erpCustomer, `FAV-${stamp}-${orderId}`, daysBack, product.erp_product_id, qty]
    );
  await line("1", `FV-${stamp}`, 5, p2);
  await line("2", `FV-${stamp}`, 10, p2);
  await line("3", `FV-${stamp}`, 20, p2);
  await line("4", `FV-${stamp}`, 8, p1);
  await line("5", `FV-${stamp}`, 400, p3); // too old
  await line("6", "10000", 3, p3); // internal stock account
  const fr = await apiRequest("/api/products/frequent", { cookie: cookieA });
  assert.equal(fr.status, 200, JSON.stringify(fr.data));
  const ids = fr.data;
  assert.ok(ids.indexOf(p2.id) >= 0 && ids.indexOf(p1.id) >= 0);
  assert.ok(ids.indexOf(p2.id) < ids.indexOf(p1.id), "3 orders rank above 1 order");
  assert.ok(!ids.includes(p3.id), "old lines and the stock account do not count");
});

test("ordered-product-ids: everything the customer ever ordered (all time), most ordered first; own customers only for a rep", async () => {
  const other = await createUser("sales_manager");
  const { createCustomer } = await import("./helpers.js");
  const erp = `FAV-C-${stamp}`;
  const customer = await createCustomer({ created_by: repA.id, assigned_manager_id: repA.id, erp_customer_id: erp });
  const line = (orderId, daysBack, product) =>
    pool.query(
      `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, brand, product_name, qty, unit_price_amd, revenue_amd)
       VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Yerevan')::date - $3::int, $4, 'Castrol', 'x', 1, 1000, 1000)`,
      [erp, `FAV-${stamp}-C${orderId}`, daysBack, product.erp_product_id]
    );
  await line("1", 900, p1); // years ago still counts
  await line("2", 800, p1);
  await line("3", 5, p3);
  const res = await apiRequest(`/api/customers/${customer.id}/ordered-product-ids`, { cookie: cookieA });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.map((r) => r.product_id), [p1.id, p3.id], "most ordered first");
  assert.equal(res.data[0].times, 2);
  const otherCookie = await loginAs(other.email);
  assert.deepEqual((await apiRequest(`/api/customers/${customer.id}/ordered-product-ids`, { cookie: otherCookie })).data, [], "another rep sees nothing");
});
