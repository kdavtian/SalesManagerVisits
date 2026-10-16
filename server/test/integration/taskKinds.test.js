// Typed tasks (migration 125): a director gives "Collect debt" / "Make order" / "Check products"; each needs a
// customer and closes itself when the work happens (payment / order / check-in recording the shop's brands).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, apiFormRequest, loginAs, trackCheckin, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const stamp = Date.now();
let director, rep, dirCookie, repCookie;

test.before(async () => {
  await startTestServer();
  director = await createUser("sales_director");
  rep = await createUser("sales_manager");
  dirCookie = await loginAs(director.email);
  repCookie = await loginAs(rep.email);
});
test.after(async () => {
  await pool.query("DELETE FROM tasks WHERE assignee_id = $1", [rep.id]);
  await pool.query("DELETE FROM payments WHERE sales_manager_id = $1", [rep.id]);
  await cleanupAll();
  await stopTestServer();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const give = (customer, task_kind, extra = {}) =>
  apiRequest("/api/tasks", { method: "POST", cookie: dirCookie, body: { title: `T-${task_kind}-${stamp}`, assignee_id: rep.id, customer_id: customer?.id, due_date: due, task_kind, ...extra } });
const status = async (id) => (await pool.query("SELECT status, outcome, completed_by FROM tasks WHERE id = $1", [id])).rows[0];

test("a typed task needs a customer and a known type; plain tasks are unchanged", async () => {
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, sales_channel: "retail" });
  const noCustomer = await give(null, "collect_debt");
  assert.equal(noCustomer.status, 400);
  const badType = await give(customer, "nonsense");
  assert.equal(badType.status, 400);
  const ok = await give(customer, "check_products");
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.task_kind, "check_products");
  const plain = await apiRequest("/api/tasks", { method: "POST", cookie: dirCookie, body: { title: "plain", assignee_id: rep.id, due_date: due } });
  assert.equal(plain.status, 201);
  assert.equal(plain.data.task_kind, null);
  const byRep = await apiRequest("/api/tasks", { method: "POST", cookie: repCookie, body: { title: "x", assignee_id: rep.id, customer_id: customer.id, due_date: due, task_kind: "make_order" } });
  assert.equal(byRep.status, 403);
});

test("Collect debt closes on a payment (and the creator is told); Make order closes on an order", async () => {
  // Orders for customers not in the ERP stay drafts (and drafts close nothing).
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, sales_channel: "retail", erp_customer_id: `ITEST-TK-${stamp}` });
  const debt = (await give(customer, "collect_debt")).data;
  const order = (await give(customer, "make_order")).data;
  const check = (await give(customer, "check_products")).data;

  const pay = await apiRequest("/api/payments", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, amount_amd: 40000 } });
  assert.equal(pay.status, 201, JSON.stringify(pay.data));
  await wait(400);
  assert.equal((await status(debt.id)).status, "done");
  assert.equal((await status(order.id)).status, "open", "a payment does not close Make order");
  assert.equal((await status(check.id)).status, "open");
  const told = (await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'task_completed' AND url = $2", [director.id, `/#/tasks?open=${debt.id}`])).rowCount;
  assert.equal(told, 1, "the person who gave the task hears it is done");

  const product = await createProduct({ unit_price_amd: 1000 });
  const o = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 1 }], payment_method: "cash" } });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  trackOrder(o.data.id);
  await wait(400);
  assert.equal((await status(order.id)).status, "done");
  assert.equal((await status(check.id)).status, "open", "an order does not close Check products");
});

test("Check products closes when a check-in records the shop's brands, not on a bare visit", async () => {
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, sales_channel: "retail" });
  const check = (await give(customer, "check_products")).data;
  const visit = async (extra) => {
    const form = new FormData();
    form.set("customer_id", String(customer.id));
    form.set("lat", String(customer.lat));
    form.set("lng", String(customer.lng));
    form.set("outcomes", JSON.stringify(["assortment_check"]));
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    const res = await apiFormRequest("/api/checkins", { cookie: repCookie, form });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    trackCheckin(res.data.id);
    await wait(400);
  };
  await visit({});
  assert.equal((await status(check.id)).status, "open", "a visit without brands does not count");
  await visit({ brand_status: JSON.stringify({ castrol: ["available"] }) });
  assert.equal((await status(check.id)).status, "done");
});

test("a typed Collect debt task requires an outcome to complete by hand, like the automatic one", async () => {
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, sales_channel: "retail" });
  const debt = (await give(customer, "collect_debt")).data;
  const bad = await apiRequest(`/api/tasks/${debt.id}/complete`, { method: "POST", cookie: repCookie, body: { note: "done" } });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  const good = await apiRequest(`/api/tasks/${debt.id}/complete`, { method: "POST", cookie: repCookie, body: { note: "", outcome: "refused" } });
  assert.equal(good.status, 200, JSON.stringify(good.data));
});
