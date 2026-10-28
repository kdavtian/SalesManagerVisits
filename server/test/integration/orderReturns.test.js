// Order returns and cancellations: request -> approve -> warehouse receipt -> recorded; partial quantities, the provisional credit, access by role, ERP match.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { matchReturnsToErp } from "../../src/orders/orderReturns.js";

let rep, rep2, director, accountant, warehouse, cookies = {}, customer, product, product2;
test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager");
  rep2 = await createUser("sales_manager");
  director = await createUser("sales_director");
  accountant = await createUser("accountant");
  warehouse = await createUser("warehouse_manager");
  for (const [k, u] of Object.entries({ rep, rep2, director, accountant, warehouse })) cookies[k] = await loginAs(u.email);
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `RT-${Date.now()}` });
  product = await createProduct({ unit: "4L", unit_price_amd: 10000 });
  product2 = await createProduct({ unit: "1L", unit_price_amd: 2000 });
  await pool.query("UPDATE products SET erp_product_id = $2 WHERE id = $1", [product.id, `RTP-${Date.now()}-A`]);
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [customer.erp_customer_id]);
  await cleanupAll();
  await stopTestServer();
});

const call = (who, path, method = "GET", body) => apiRequest(`/api/returns${path}`, { method, cookie: cookies[who], body });
async function newOrder(status, discountPct = 0) {
  const res = await apiRequest("/api/orders", { method: "POST", cookie: cookies.rep, body: { customer_id: customer.id, payment_method: "invoice", items: [{ product_id: product.id, quantity: 10 }, { product_id: product2.id, quantity: 5 }] } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackOrder(res.data.id);
  await pool.query("UPDATE orders SET status = $2, discount_pct = $3 WHERE id = $1", [res.data.id, status, discountPct]);
  return res.data.id;
}
const items = async (orderId) => (await pool.query("SELECT id, product_id, quantity::float8 AS q FROM order_items WHERE order_id = $1 ORDER BY id", [orderId])).rows;

test("a delivered order: partial return, quantities capped, credit at the price the customer paid, approval, warehouse receipt, recorded", async () => {
  const orderId = await newOrder("delivered");
  const [a, b] = await items(orderId);
  assert.equal((await call("rep", "/", "POST", { order_id: orderId, reason: "damaged", items: [{ order_item_id: a.id, quantity: 11 }] })).status, 409, "more than delivered");
  assert.equal((await call("rep", "/", "POST", { order_id: orderId, reason: "damaged", items: [] })).status, 400);
  assert.equal((await call("rep", "/", "POST", { order_id: orderId, reason: "nope", items: [{ order_item_id: a.id, quantity: 1 }] })).status, 400);
  assert.equal((await call("rep", "/", "POST", { order_id: orderId, reason: "other", items: [{ order_item_id: a.id, quantity: 1 }] })).status, 400, "Other needs a note");
  assert.equal((await call("rep2", "/", "POST", { order_id: orderId, reason: "damaged", items: [{ order_item_id: a.id, quantity: 1 }] })).status, 403, "someone else's order");
  assert.equal((await call("warehouse", "/", "POST", { order_id: orderId, reason: "damaged", items: [{ order_item_id: a.id, quantity: 1 }] })).status, 403);

  const made = await call("rep", "/", "POST", { order_id: orderId, reason: "damaged", note: "leaking cans", items: [{ order_item_id: a.id, quantity: 4 }, { order_item_id: b.id, quantity: 1 }] });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.kind, "return");
  const id = made.data.id;
  let list = (await call("rep", `/?order_id=${orderId}`)).data;
  assert.equal(list[0].credit_amd, 4 * 10000 + 2000);
  assert.equal(list[0].status, "requested");
  // the rest can still be returned, but not more
  assert.equal((await call("rep", "/", "POST", { order_id: orderId, reason: "damaged", items: [{ order_item_id: a.id, quantity: 7 }] })).status, 409);
  assert.equal((await call("rep", "/", "POST", { order_id: orderId, reason: "damaged", items: [{ order_item_id: a.id, quantity: 6 }] })).status, 201);

  assert.equal((await call("rep", `/${id}/approve`, "POST", {})).status, 403, "a rep does not approve");
  assert.equal((await call("director", `/${id}/reject`, "POST", {})).status, 400, "a rejection needs a reason");
  assert.equal((await call("director", `/${id}/approve`, "POST", { note: "ok" })).status, 200);
  assert.equal((await call("director", `/${id}/approve`, "POST", {})).status, 409, "already decided");

  // provisional credit is on the customer now
  let c = (await apiRequest(`/api/customers/${customer.id}`, { cookie: cookies.rep })).data;
  assert.equal(c.pending_return_credit.amd, 42000, "only the approved request counts, not the second one still waiting");

  assert.equal((await call("rep", `/${id}/receive`, "POST", {})).status, 403);
  const detail = (await call("warehouse", "/?status=approved")).data.find((r) => r.id === id);
  const rec = await call("warehouse", `/${id}/receive`, "POST", { items: [{ id: detail.items[0].id, condition: "damaged" }] });
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  const done = (await call("rep", `/?order_id=${orderId}`)).data.find((r) => r.id === id);
  assert.equal(done.status, "done");
  assert.deepEqual(done.items.map((i) => i.condition), ["damaged", "good"]);

  // the accountant records it (manual), then the credit leaves the customer
  assert.equal((await call("director", `/${id}/recorded`, "POST", {})).status, 403);
  assert.equal((await call("accountant", `/${id}/recorded`, "POST", {})).status, 200);
  c = (await apiRequest(`/api/customers/${customer.id}`, { cookie: cookies.rep })).data;
  assert.equal(c.pending_return_credit.amd, 0);
});

test("the credit follows the discount the customer got", async () => {
  const orderId = await newOrder("delivered", 10);
  await pool.query("UPDATE orders SET total_amd = total_amd * 0.9 WHERE id = $1", [orderId]); // what a 10 % discount does to the total
  const [a] = await items(orderId);
  const made = await call("rep", "/", "POST", { order_id: orderId, reason: "wrong_product", items: [{ order_item_id: a.id, quantity: 2 }] });
  assert.equal(made.status, 201);
  const row = (await call("director", `/?order_id=${orderId}`)).data[0];
  assert.equal(row.credit_amd, Math.round(10000 * 0.9 * 2));
});

test("cancelling an order that is not delivered: approval cancels it; a packed order waits for the warehouse; delivered orders are returns", async () => {
  const submitted = await newOrder("submitted");
  const made = await call("rep", "/", "POST", { order_id: submitted, reason: "changed_mind" });
  assert.equal(made.status, 201);
  assert.equal(made.data.kind, "cancel");
  assert.equal((await call("rep", "/", "POST", { order_id: submitted, reason: "changed_mind" })).status, 409, "one waiting cancellation per order");
  assert.equal((await call("accountant", `/${made.data.id}/approve`, "POST", {})).status, 200);
  const o = (await pool.query("SELECT status, cancelled_at, cancel_reason FROM orders WHERE id = $1", [submitted])).rows[0];
  assert.deepEqual([o.status, Boolean(o.cancelled_at)], ["draft", true]);
  assert.equal((await call("rep", "/", "POST", { order_id: submitted, reason: "changed_mind" })).status, 409, "already cancelled");

  const packed = await newOrder("packed_stock_out");
  const m2 = await call("rep", "/", "POST", { order_id: packed, reason: "changed_mind" });
  assert.equal((await call("director", `/${m2.data.id}/approve`, "POST", {})).status, 200);
  assert.equal((await pool.query("SELECT status FROM orders WHERE id = $1", [packed])).rows[0].status, "packed_stock_out", "still packed until the goods are back");
  assert.equal((await call("warehouse", `/${m2.data.id}/receive`, "POST", {})).status, 200);
  const o2 = (await pool.query("SELECT status, cancelled_at FROM orders WHERE id = $1", [packed])).rows[0];
  assert.deepEqual([o2.status, Boolean(o2.cancelled_at)], ["draft", true]);

  const draft = await newOrder("draft");
  assert.equal((await call("rep", "/", "POST", { order_id: draft, reason: "changed_mind" })).status, 400, "a draft is just deleted");
  const rejected = await newOrder("confirmed");
  const m3 = await call("rep", "/", "POST", { order_id: rejected, reason: "changed_mind" });
  assert.equal((await call("director", `/${m3.data.id}/reject`, "POST", { note: "already on the truck" })).status, 200);
  assert.equal((await pool.query("SELECT status FROM orders WHERE id = $1", [rejected])).rows[0].status, "confirmed");
  // the order moved on after the request: approval refuses
  const moved = await newOrder("confirmed");
  const m4 = await call("rep", "/", "POST", { order_id: moved, reason: "changed_mind" });
  await pool.query("UPDATE orders SET status = 'delivered' WHERE id = $1", [moved]);
  assert.equal((await call("director", `/${m4.data.id}/approve`, "POST", {})).status, 409);
});

test("ERP: negative lines of the same customer and product mark the return as recorded in ERP", async () => {
  const orderId = await newOrder("delivered");
  const [a] = await items(orderId);
  const made = await call("rep", "/", "POST", { order_id: orderId, reason: "expired", items: [{ order_item_id: a.id, quantity: 3 }] });
  await call("director", `/${made.data.id}/approve`, "POST", {});
  await matchReturnsToErp(); // nothing in ERP yet
  assert.equal((await pool.query("SELECT recorded_at FROM order_returns WHERE id = $1", [made.data.id])).rows[0].recorded_at, null);
  const erpProduct = (await pool.query("SELECT erp_product_id FROM products WHERE id = $1", [product.id])).rows[0].erp_product_id;
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, qty, revenue_amd) VALUES ($1, 'RET1', (now() AT TIME ZONE 'Asia/Yerevan')::date, $2, -2, -20000)", [customer.erp_customer_id, erpProduct]);
  await matchReturnsToErp();
  assert.equal((await pool.query("SELECT recorded_at FROM order_returns WHERE id = $1", [made.data.id])).rows[0].recorded_at, null, "2 of 3 is not enough");
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, qty, revenue_amd) VALUES ($1, 'RET2', (now() AT TIME ZONE 'Asia/Yerevan')::date, $2, -1, -10000)", [customer.erp_customer_id, erpProduct]);
  await matchReturnsToErp();
  const r = (await pool.query("SELECT recorded_at, recorded_via FROM order_returns WHERE id = $1", [made.data.id])).rows[0];
  assert.ok(r.recorded_at);
  assert.equal(r.recorded_via, "erp");
});

test("who sees what: a rep only their own, the warehouse manager and management everything; counts per role", async () => {
  const mine = (await call("rep", "/")).data;
  assert.ok(mine.length > 0);
  assert.deepEqual((await call("rep2", "/")).data, []);
  assert.ok((await call("director", "/")).data.length >= mine.length);
  assert.ok((await call("warehouse", "/")).data.length >= 1);
  const counts = (await call("director", "/counts")).data;
  assert.ok(counts.to_decide >= 0 && "to_record" in counts);
  const returnable = (await call("rep", `/order/${(mine[0]).order_id}/returnable`)).data;
  assert.equal(returnable.kind, "return");
  assert.ok(returnable.items.every((i) => i.left >= 0));
  assert.equal((await call("rep2", `/order/${mine[0].order_id}/returnable`)).status, 403);
});
