// Discount policy, price-sync log, credit-limit history, collection outcomes with promise
// dates, reorder follow-up tasks, and the warehouse reorder list.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { createDebtCollectionTasks, createReorderFollowupTasks } from "../../src/debtCollectionTasks.js";
import { snapshotTierPrices, logTierPriceChanges } from "../../src/priceSyncLog.js";

let users;
let cookies;
const erpIds = [];
const stamp = Date.now();

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "ceo", "sales_director", "sales_manager", "accountant"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
});
test.after(async () => {
  await pool.query("DELETE FROM tasks WHERE assignee_id = ANY($1)", [Object.values(users).map((u) => u.id)]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = ANY($1) OR order_id LIKE $2", [erpIds, `ITEST-BR2-${stamp}%`]);
  await cleanupAll();
  await stopTestServer();
});

async function erpCustomer(suffix, debt = 0, days = 0) {
  const erpId = `ITEST-BR2-${suffix}-${stamp}`;
  erpIds.push(erpId);
  const customer = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: users.sales_manager.id, erp_customer_id: erpId });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, days_since_payment, synced_at) VALUES ($1, 'x', $2, $3, now())", [erpId, debt, days]);
  return customer;
}
async function order(customer, product, quantity, extra = {}) {
  const res = await apiRequest("/api/orders", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { customer_id: customer.id, items: [{ product_id: product.id, quantity }], payment_method: "invoice", ...extra },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackOrder(res.data.id);
  return res.data;
}

test("discounts: up to 3% auto-approved; the sales director may not go below net cost, the CEO may", async () => {
  const customer = await erpCustomer("disc");
  const product = await createProduct({ unit_price_amd: 1000 });
  await pool.query("UPDATE products SET net_cost_amd = 800, bronze_price_amd = 1000 WHERE id = $1", [product.id]);

  const small = await order(customer, product, 10, { discount_pct: 2 });
  assert.equal(small.approval_status, "approved");

  const mid = await order(customer, product, 10, { discount_pct: 5 }); // price 950 >= 800
  assert.equal(mid.approval_status, "pending");
  assert.equal((await apiRequest(`/api/orders/${mid.id}/approve-discount`, { method: "POST", cookie: cookies.sales_director })).status, 200);

  const deep = await order(customer, product, 10, { discount_pct: 25 }); // price 750 < 800
  assert.equal(deep.approval_status, "pending");
  const blocked = await apiRequest(`/api/orders/${deep.id}/approve-discount`, { method: "POST", cookie: cookies.sales_director });
  assert.equal(blocked.status, 403);
  assert.match(blocked.data.error, /net cost/i);
  assert.equal((await apiRequest(`/api/orders/${deep.id}/approve-discount`, { method: "POST", cookie: cookies.ceo })).status, 200);

  // The margin is internal: directors see it, the rep does not.
  const asDirector = await apiRequest(`/api/orders/${mid.id}`, { cookie: cookies.sales_director });
  assert.ok(asDirector.data.pricing_check.margin_pct > 0);
  const asRep = await apiRequest(`/api/orders/${mid.id}`, { cookie: cookies.sales_manager });
  assert.equal(asRep.data.pricing_check, null);
});

test("ERP price changes are logged once; first-time prices are not changes", async () => {
  const product = await createProduct({ unit_price_amd: 1000 });
  const erpProductId = `ITEST-BR2-P-${stamp}`;
  await pool.query("UPDATE products SET erp_product_id = $2, bronze_price_amd = 1000, silver_price_amd = NULL WHERE id = $1", [product.id, erpProductId]);
  const before = await snapshotTierPrices(pool, [erpProductId]);
  await pool.query("UPDATE products SET bronze_price_amd = 1100, silver_price_amd = 900 WHERE id = $1", [product.id]);
  const changed = await logTierPriceChanges(pool, before, [erpProductId]);
  assert.equal(changed, 1);
  const { rows } = await pool.query("SELECT price_type, old_value, new_value, note FROM product_price_history WHERE product_id = $1", [product.id]);
  assert.equal(rows.length, 1); // bronze 1000 -> 1100; silver NULL -> 900 is a first price
  assert.deepEqual({ ...rows[0], old_value: Number(rows[0].old_value), new_value: Number(rows[0].new_value) }, { price_type: "bronze", old_value: 1000, new_value: 1100, note: "ERP sync" });
});

test("credit limit changes are logged with who changed them; unchanged saves are not", async () => {
  const customer = await erpCustomer("hist");
  const put = (limit) => apiRequest(`/api/customers/${customer.id}/credit-terms`, { method: "PUT", cookie: cookies.accountant, body: { credit_limit_amd: limit } });
  assert.equal((await put(100000)).status, 200);
  assert.equal((await put(100000)).status, 200); // same value: no new row
  assert.equal((await put(250000)).status, 200);
  const hist = await apiRequest(`/api/customers/${customer.id}/credit-history`, { cookie: cookies.accountant });
  assert.equal(hist.status, 200);
  assert.equal(hist.data.length, 2);
  assert.equal(hist.data[0].new_limit, 250000);
  assert.equal(hist.data[0].old_limit, 100000);
  assert.equal(hist.data[0].changed_by_name, users.accountant.name);
  assert.equal((await apiRequest(`/api/customers/${customer.id}/credit-history`, { cookie: cookies.sales_manager })).status, 403);
});

test("collection outcome is required; a promised date holds new tasks until it passes, then escalates", async () => {
  const customer = await erpCustomer("promise", 600000, 90);
  await createDebtCollectionTasks();
  const task = (await pool.query("SELECT id FROM tasks WHERE customer_id = $1 AND auto_kind = 'debt_collection'", [customer.id])).rows[0];
  assert.ok(task);
  const complete = (body) => apiRequest(`/api/tasks/${task.id}/complete`, { method: "POST", cookie: cookies.sales_manager, body });
  assert.equal((await complete({})).status, 400, "an outcome is required");
  assert.equal((await complete({ outcome: "promised" })).status, 400, "a promise needs a date");
  assert.equal((await complete({ outcome: "promised", promise_date: "2020-01-01" })).status, 400, "a past date is refused");
  const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const done = await complete({ outcome: "promised", promise_date: future });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.outcome, "promised");
  assert.equal(done.data.promise_date, future);

  // Promise still running: nothing new, even after the 14-day cooldown.
  await pool.query("UPDATE tasks SET created_at = now() - interval '40 days' WHERE id = $1", [task.id]);
  const during = await createDebtCollectionTasks();
  assert.equal((await pool.query("SELECT 1 FROM tasks WHERE customer_id = $1 AND auto_kind = 'debt_collection'", [customer.id])).rowCount, 1);
  assert.ok(during.broken === 0);

  // Promise date passed and the debt is still there: a new task at once, and a broken promise is reported.
  await pool.query("UPDATE tasks SET promise_date = (now() AT TIME ZONE 'Asia/Yerevan')::date - 1 WHERE id = $1", [task.id]);
  const after = await createDebtCollectionTasks();
  assert.ok(after.broken >= 1);
  assert.equal((await pool.query("SELECT 1 FROM tasks WHERE customer_id = $1 AND auto_kind = 'debt_collection'", [customer.id])).rowCount, 2);
});

test("reorder follow-up: a customer past their usual rhythm gets a task, unless a credit term is exceeded", async () => {
  const mkOrders = async (customer) => {
    // 6 orders, 14 days apart, the last one 60 days ago.
    for (let i = 0; i < 6; i++) {
      await pool.query(
        "INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, CURRENT_DATE - $3::int, 10000)",
        [customer.erp_customer_id, `ITEST-BR2-O-${customer.id}-${i}-${stamp}`, 60 + i * 14]
      );
    }
  };
  const ok = await erpCustomer("reorder-ok", 0, 5);
  const overdue = await erpCustomer("reorder-debt", 500000, 90);
  const overLimit = await erpCustomer("reorder-limit", 50000, 5);
  await pool.query("UPDATE customers SET credit_limit_amd = 10000 WHERE id = $1", [overLimit.id]);
  for (const c of [ok, overdue, overLimit]) await mkOrders(c);

  const res = await createReorderFollowupTasks();
  assert.ok(res.created >= 1);
  const has = async (c) => (await pool.query("SELECT 1 FROM tasks WHERE customer_id = $1 AND auto_kind = 'reorder_followup'", [c.id])).rowCount;
  assert.equal(await has(ok), 1);
  assert.equal(await has(overdue), 0, "overdue debt: no sales push");
  assert.equal(await has(overLimit), 0, "credit limit exceeded: no sales push");
  await createReorderFollowupTasks();
  assert.equal(await has(ok), 1, "no duplicate");
});

test("warehouse 'To order' list suggests pieces for low products", async () => {
  const product = await createProduct({ unit_price_amd: 1000 });
  const erpProductId = `ITEST-BR2-RO-${stamp}`;
  await pool.query("UPDATE products SET erp_product_id = $2, stock_qty = 5 WHERE id = $1", [product.id, erpProductId]);
  // Sold 60 pieces in the last 30 days: ~2 per day, so 5 in stock is ~2 days.
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, qty, revenue_amd) VALUES ('ITEST-BR2-RO', $1, CURRENT_DATE - 3, $2, 60, 60000)", [`ITEST-BR2-${stamp}-RO`, erpProductId]);
  const res = await apiRequest("/api/warehouse/reorder-suggestions", { cookie: cookies.admin });
  assert.equal(res.status, 200);
  const row = res.data.find((r) => r.id === product.id);
  assert.ok(row, "the low product is listed");
  assert.equal(row.urgency, "critical");
  assert.ok(row.suggested_qty > 100);
});
