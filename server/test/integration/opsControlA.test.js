// Operations control (part 1): price floor below landing cost, credit-limit suggestions, legacy balance decisions.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, loginAs, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { createDebtCollectionTasks } from "../../src/debtCollectionTasks.js";
import { suggestLimit } from "../../src/creditLimitSuggest.js";

let admin, director, accountant, rep, adminCookie, directorCookie, accountantCookie, repCookie, customer, cheap, normal;
const stamp = Date.now();

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  director = await createUser("sales_director");
  accountant = await createUser("accountant");
  rep = await createUser("sales_manager");
  [adminCookie, directorCookie, accountantCookie, repCookie] = await Promise.all([admin, director, accountant, rep].map((u) => loginAs(u.email)));
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `OPS-${stamp}` });
  cheap = await createProduct({ unit: "4L" });
  normal = await createProduct({ unit: "4L" });
  // "cheap": silver price BELOW landing cost (a pricing error); "normal": healthy margin
  await pool.query("UPDATE products SET unit_price_amd = 8000, bronze_price_amd = 8000, silver_price_amd = 8000, landing_cost_amd = 10000, net_cost_amd = 6000 WHERE id = $1", [cheap.id]);
  await pool.query("UPDATE products SET unit_price_amd = 20000, bronze_price_amd = 20000, silver_price_amd = 20000, landing_cost_amd = 10000, net_cost_amd = 6000 WHERE id = $1", [normal.id]);
});
test.after(async () => {
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id LIKE $1", [`OPS-${stamp}%`]);
  await pool.query("DELETE FROM tasks WHERE auto_kind = 'debt_collection' AND customer_id IN (SELECT id FROM customers WHERE erp_customer_id LIKE $1)", [`OPS-${stamp}%`]);
  await cleanupAll();
  await stopTestServer();
});

const order = (productId, extra = {}) =>
  apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, payment_method: "cash", items: [{ product_id: productId, quantity: 1 }], ...extra } });

test("price floor: a line below LANDING cost needs the CEO/admin even without a discount; a healthy line does not", async () => {
  const ok = await order(normal.id);
  assert.equal(ok.status, 201);
  trackOrder(ok.data.id);
  assert.equal(ok.data.approval_status, "not_required");

  const low = await order(cheap.id);
  assert.equal(low.status, 201);
  trackOrder(low.data.id);
  assert.equal(low.data.approval_status, "pending", "no discount, still pending: the price itself is below landing cost");

  assert.equal((await apiRequest(`/api/orders/${low.data.id}/approve-discount`, { method: "POST", cookie: directorCookie })).status, 403, "a sales director cannot approve below landing");
  const done = await apiRequest(`/api/orders/${low.data.id}/approve-discount`, { method: "POST", cookie: adminCookie });
  assert.equal(done.status, 200);
  assert.equal(done.data.approval_status, "approved");

  const detail = await apiRequest(`/api/orders/${low.data.id}`, { cookie: adminCookie });
  assert.equal(detail.data.pricing_check.below_landing, true);
});

test("price-check preview: yes/no and product ids, never a cost; saves nothing", async () => {
  const lowRes = await apiRequest("/api/orders/price-check", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, items: [{ product_id: cheap.id, quantity: 2 }] } });
  assert.equal(lowRes.status, 200);
  assert.deepEqual(lowRes.data, { below_landing: true, product_ids: [cheap.id] });
  const okRes = await apiRequest("/api/orders/price-check", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, items: [{ product_id: normal.id, quantity: 2 }] } });
  assert.equal(okRes.data.below_landing, false);
  // a 60 % discount drives even the healthy product below landing cost
  const deep = await apiRequest("/api/orders/price-check", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, items: [{ product_id: normal.id, quantity: 1 }], discount_pct: 60 } });
  assert.equal(deep.data.below_landing, true);
  assert.equal((await apiRequest("/api/orders/price-check", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, items: [] } })).status, 400);
});

test("special price below landing cost is flagged when read back", async () => {
  await pool.query("UPDATE customers SET customer_tier = 'gold' WHERE id = $1", [customer.id]);
  const put = await apiRequest(`/api/customers/${customer.id}/product-prices`, { method: "PUT", cookie: directorCookie, body: { prices: [{ product_id: normal.id, price_amd: 9000 }] } });
  assert.equal(put.status, 200);
  assert.equal(put.data[0].below_landing, true);
  const get = await apiRequest(`/api/customers/${customer.id}/product-prices`, { cookie: directorCookie });
  assert.equal(get.data[0].below_landing, true);
  await pool.query("DELETE FROM customer_product_prices WHERE customer_id = $1", [customer.id]);
  await pool.query("UPDATE customers SET customer_tier = 'bronze' WHERE id = $1", [customer.id]);
});

test("credit limit suggestions: formula, only customers without a limit, never overwrites", async () => {
  assert.equal(suggestLimit({ monthlyAvg: 0, termDays: 45, cash: false }), 300000, "floor");
  assert.equal(suggestLimit({ monthlyAvg: 2_000_000, termDays: 45, cash: false }), 3_800_000, "2M x 1.5 x 1.25 = 3.75M -> 3.8M");
  assert.equal(suggestLimit({ monthlyAvg: 2_000_000, termDays: 45, cash: true }), 600000, "cash = 7 days: 583k -> 600k");

  assert.equal((await apiRequest("/api/ops/credit-limits", { cookie: repCookie })).status, 403);
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at) VALUES ($1, 'x', 900000, now()) ON CONFLICT (erp_customer_id) DO UPDATE SET debt_amd = 900000", [`OPS-${stamp}`]);
  const res = await apiRequest("/api/ops/credit-limits", { cookie: accountantCookie });
  assert.equal(res.status, 200);
  const mine = res.data.suggestions.find((s) => s.customer_id === customer.id);
  assert.ok(mine, "the customer has no limit yet");
  assert.equal(mine.suggested_amd, 300000);
  assert.equal(mine.over_now, true, "debt 900k > 300k suggested");
  assert.equal(res.data.can_apply, true);

  const applied = await apiRequest("/api/ops/credit-limits/apply", { method: "POST", cookie: accountantCookie, body: { items: [{ customer_id: customer.id, limit: 1_000_000 }] } });
  assert.deepEqual(applied.data, { applied: 1, skipped: 0 });
  const again = await apiRequest("/api/ops/credit-limits/apply", { method: "POST", cookie: accountantCookie, body: { items: [{ customer_id: customer.id, limit: 5_000_000 }] } });
  assert.deepEqual(again.data, { applied: 0, skipped: 1 }, "an existing limit is never overwritten");
  const row = (await pool.query("SELECT credit_limit_amd::float8 AS l FROM customers WHERE id = $1", [customer.id])).rows[0];
  assert.equal(row.l, 1_000_000);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM customer_credit_limit_log WHERE customer_id = $1 AND new_limit = 1000000", [customer.id])).rows[0].n, 1);
  assert.equal((await apiRequest("/api/ops/credit-limits/apply", { method: "POST", cookie: repCookie, body: { items: [{ customer_id: customer.id, limit: 1 }] } })).status, 403);
  await pool.query("UPDATE customers SET credit_limit_amd = NULL WHERE id = $1", [customer.id]);
});

test("legacy balances: listed with facts; only CEO/admin decide; decisions steer the automatic collection tasks", async () => {
  await pool.query("UPDATE customers SET sales_channel = 'KF' WHERE id = $1", [customer.id]);
  await pool.query("UPDATE erp_customer_data SET debt_amd = 5000000, balance0_amd = 4500000, last_payment_date = NULL, days_since_payment = NULL WHERE erp_customer_id = $1", [`OPS-${stamp}`]);
  const list = await apiRequest("/api/ops/legacy-balances", { cookie: directorCookie });
  assert.equal(list.status, 200);
  const row = list.data.items.find((i) => i.customer_id === customer.id);
  assert.ok(row, `not listed: ${list.data.items.length} items, total ${list.data.total_amd}`);
  assert.equal(row.debt_amd, 5000000);
  assert.equal(row.never_paid, true);
  assert.equal(row.decision, null);
  assert.ok(list.data.undecided_count >= 1);

  assert.equal((await apiRequest(`/api/ops/legacy-balances/${customer.id}`, { method: "PUT", cookie: directorCookie, body: { decision: "legal" } })).status, 403, "a sales director only sees");
  assert.equal((await apiRequest(`/api/ops/legacy-balances/${customer.id}`, { method: "PUT", cookie: adminCookie, body: { decision: "nonsense" } })).status, 400);

  // key-account channel (KF): no automatic task by default
  const count = async () => (await pool.query("SELECT count(*)::int AS n FROM tasks WHERE customer_id = $1 AND auto_kind = 'debt_collection' AND status = 'open'", [customer.id])).rows[0].n;
  await createDebtCollectionTasks(new Date(), { notify: false });
  assert.equal(await count(), 0);
  // "collect" = we do chase it: a task for the sales director
  await apiRequest(`/api/ops/legacy-balances/${customer.id}`, { method: "PUT", cookie: adminCookie, body: { decision: "collect", note: "Խոսել տնօրենի հետ" } });
  await createDebtCollectionTasks(new Date(), { notify: false });
  assert.equal(await count(), 1);
  // "legal" = stop the automatic chasing and cancel the open task
  await apiRequest(`/api/ops/legacy-balances/${customer.id}`, { method: "PUT", cookie: adminCookie, body: { decision: "legal" } });
  await createDebtCollectionTasks(new Date(), { notify: false });
  assert.equal(await count(), 0);
  const after = (await apiRequest("/api/ops/legacy-balances", { cookie: adminCookie })).data.items.find((i) => i.customer_id === customer.id);
  assert.equal(after.decision, "legal");
  assert.equal((await apiRequest(`/api/ops/legacy-balances/${customer.id}`, { method: "PUT", cookie: adminCookie, body: { decision: null } })).status, 204);
});
