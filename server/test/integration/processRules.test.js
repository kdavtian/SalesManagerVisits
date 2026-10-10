// Process-logic fixes: credit limit approval, out-of-range check-ins not
// counting as visits, a failed delivery staying "packed", the manual
// order <-> Excel link, and stock available after other orders' reservations.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let users;
let cookies;
const erpIds = [];
const stamp = Date.now();

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "sales_director", "sales_manager", "accountant", "delivery_manager"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
});
test.after(async () => {
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = ANY($1)", [erpIds]);
  await cleanupAll();
  await stopTestServer();
});

async function erpCustomer(suffix, debt = 0) {
  const erpId = `ITEST-PR-${suffix}-${stamp}`;
  erpIds.push(erpId);
  const customer = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: users.sales_manager.id, erp_customer_id: erpId });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at) VALUES ($1, 'x', $2, now())", [erpId, debt]);
  return customer;
}
async function order(customer, product, quantity) {
  const res = await apiRequest("/api/orders", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity }], payment_method: "invoice" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackOrder(res.data.id);
  return res.data;
}

test("credit limit: an over-limit order needs a director's approval before it can be confirmed", async () => {
  const customer = await erpCustomer("credit", 100000);
  const product = await createProduct({ unit_price_amd: 1000 });
  // Only the accountant / directors set credit terms.
  const denied = await apiRequest(`/api/customers/${customer.id}/credit-terms`, { method: "PUT", cookie: cookies.sales_manager, body: { credit_limit_amd: 150000 } });
  assert.equal(denied.status, 403);
  const set = await apiRequest(`/api/customers/${customer.id}/credit-terms`, { method: "PUT", cookie: cookies.accountant, body: { credit_limit_amd: 150000 } });
  assert.equal(set.status, 200);
  assert.equal(set.data.credit_limit_amd, 150000);

  const small = await order(customer, product, 10); // 100k debt + 10k = 110k <= 150k
  assert.equal(small.credit_status, "not_required");

  const big = await order(customer, product, 100); // 100k + 10k open + 100k = 210k > 150k
  assert.equal(big.credit_status, "pending");

  const blocked = await apiRequest(`/api/orders/${big.id}`, { method: "PATCH", cookie: cookies.sales_director, body: { status: "confirmed" } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /credit limit/i);

  assert.equal((await apiRequest(`/api/orders/${big.id}/approve-credit`, { method: "POST", cookie: cookies.accountant })).status, 403);
  const approved = await apiRequest(`/api/orders/${big.id}/approve-credit`, { method: "POST", cookie: cookies.sales_director });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.credit_status, "approved");
  const confirmed = await apiRequest(`/api/orders/${big.id}`, { method: "PATCH", cookie: cookies.sales_director, body: { status: "confirmed" } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));

  // No limit = no check.
  await apiRequest(`/api/customers/${customer.id}/credit-terms`, { method: "PUT", cookie: cookies.accountant, body: { credit_limit_amd: null } });
  const free = await order(customer, product, 500);
  assert.equal(free.credit_status, "not_required");
});

test("an out-of-range check-in does not count as a visit", async () => {
  const customer = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: users.sales_manager.id });
  const insert = (withinRange) =>
    pool.query(
      `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, timestamp) VALUES ($1, $2, 40.18, 44.51, $3, $4, now()) RETURNING id`,
      [customer.id, users.sales_manager.id, withinRange ? 5 : 5000, withinRange]
    );
  await insert(false);
  const before = await apiRequest(`/api/customers/${customer.id}`, { cookie: cookies.sales_manager });
  assert.equal(before.data.last_visit_at, null);
  assert.equal(before.data.visited_today, false);
  await insert(true);
  const after = await apiRequest(`/api/customers/${customer.id}`, { cookie: cookies.sales_manager });
  assert.ok(after.data.last_visit_at);
  assert.equal(after.data.visited_today, true);
});

test("a failed delivery leaves the order packed (not draft)", async () => {
  const customer = await erpCustomer("fail");
  const product = await createProduct();
  const o = await order(customer, product, 1);
  await pool.query("UPDATE orders SET status = 'packed_stock_out' WHERE id = $1", [o.id]);
  const res = await apiRequest(`/api/delivery/orders/${o.id}/fail`, { method: "POST", cookie: cookies.delivery_manager });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, "packed_stock_out");
  const { rows } = await pool.query("SELECT status FROM orders WHERE id = $1", [o.id]);
  assert.equal(rows[0].status, "packed_stock_out");
});

test("manual link: an unmatched confirmed order can be linked to a free Excel order once", async () => {
  const customer = await erpCustomer("link");
  const product = await createProduct({ unit_price_amd: 1000 });
  const o = await order(customer, product, 5); // 5000
  await pool.query("UPDATE orders SET status = 'confirmed' WHERE id = $1", [o.id]);
  const excelId = `ITEST-EXCEL-${stamp}`;
  // The accountant changed the total in Excel, so the automatic match would not find it.
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, CURRENT_DATE, 4500)", [customer.erp_customer_id, excelId]);

  assert.equal((await apiRequest(`/api/orders/${o.id}/erp-candidates`, { cookie: cookies.sales_manager })).status, 403);
  const cands = await apiRequest(`/api/orders/${o.id}/erp-candidates`, { cookie: cookies.accountant });
  assert.equal(cands.status, 200);
  assert.ok(cands.data.some((c) => c.erp_order_id === excelId && c.diff_amd === 500));

  assert.equal((await apiRequest(`/api/orders/${o.id}/link-erp`, { method: "POST", cookie: cookies.accountant, body: { erp_order_id: "nope" } })).status, 409);
  const linked = await apiRequest(`/api/orders/${o.id}/link-erp`, { method: "POST", cookie: cookies.accountant, body: { erp_order_id: excelId } });
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  assert.equal(linked.data.status, "delivered");
  assert.equal(linked.data.delivered_from_erp, true);
  assert.equal(linked.data.erp_matched_order_id, excelId);
  // The same Excel order cannot be linked twice.
  const o2 = await order(customer, product, 5);
  await pool.query("UPDATE orders SET status = 'confirmed' WHERE id = $1", [o2.id]);
  assert.equal((await apiRequest(`/api/orders/${o2.id}/link-erp`, { method: "POST", cookie: cookies.accountant, body: { erp_order_id: excelId } })).status, 409);
});

test("products show stock still available after other orders' reservations", async () => {
  const customer = await erpCustomer("stock");
  const product = await createProduct({ unit_price_amd: 1000 });
  await pool.query("UPDATE products SET stock_qty = 10 WHERE id = $1", [product.id]);
  await order(customer, product, 4);
  const list = await apiRequest("/api/products", { cookie: cookies.sales_manager });
  const p = list.data.find((x) => x.id === product.id);
  assert.equal(p.reserved_qty, 4);
  assert.equal(p.available_qty, 6);
});
