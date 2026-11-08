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

test("a typed Collect debt task cannot be completed by hand: the rep records what the customer said and it stays open (owner, 2026-11-05)", async () => {
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, sales_channel: "retail" });
  const debt = (await give(customer, "collect_debt")).data;
  const bad = await apiRequest(`/api/tasks/${debt.id}/complete`, { method: "POST", cookie: repCookie, body: { note: "done", outcome: "refused" } });
  assert.equal(bad.status, 409, JSON.stringify(bad.data));
  const good = await apiRequest(`/api/tasks/${debt.id}/record-result`, { method: "POST", cookie: repCookie, body: { note: "", outcome: "refused" } });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.equal(good.data.status, "open");
});

// Owner, 2026-11-08: "make order" and "he stopped ordering" tasks close only by an order (or by a visit that says why there was none).
test("a Make order task and the automatic 'stopped ordering' task cannot be completed by hand; a plain task still can", async () => {
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, sales_channel: "retail" });
  const order = (await give(customer, "make_order", { items: ["Call and ask"] })).data;
  const auto = (await pool.query(
    "INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, due_is_next_visit, auto_kind) VALUES ('he stopped ordering', $1, $2, $3, current_date, true, 'reorder_followup') RETURNING id",
    [director.id, rep.id, customer.id]
  )).rows[0];
  for (const id of [order.id, auto.id]) {
    const done = await apiRequest(`/api/tasks/${id}/complete`, { method: "POST", cookie: repCookie, body: { note: "done" } });
    assert.equal(done.status, 409, JSON.stringify(done.data));
    assert.equal(done.data.code, "closes_itself");
    assert.equal((await status(id)).status, "open");
  }
  // ticking the checklist is not a way round it
  const full = (await apiRequest(`/api/tasks/${order.id}`, { cookie: repCookie })).data;
  assert.ok(full.items.length);
  const ticked = await apiRequest(`/api/tasks/${order.id}/items/${full.items[0].id}`, { method: "POST", cookie: repCookie, body: { done: true } });
  assert.equal(ticked.status, 200);
  assert.equal((await status(order.id)).status, "open", "the checklist never finishes a self-closing task");
  // a call that "spoke" is logged but does not finish the automatic order task either
  const called = await apiRequest(`/api/tasks/${auto.id}/call-result`, { method: "POST", cookie: repCookie, body: { result: "spoke", note: "will think" } });
  assert.equal(called.status, 200, JSON.stringify(called.data));
  assert.equal((await status(auto.id)).status, "open");
  const plain = await apiRequest("/api/tasks", { method: "POST", cookie: dirCookie, body: { title: "plain", assignee_id: rep.id, due_date: due } });
  const ok = await apiRequest(`/api/tasks/${plain.data.id}/complete`, { method: "POST", cookie: repCookie, body: {} });
  assert.equal(ok.status, 200);
  assert.equal((await status(plain.data.id)).status, "done");
  // management may cancel one, with a reason
  const cancel = await apiRequest(`/api/tasks/${order.id}`, { method: "PATCH", cookie: dirCookie, body: { status: "cancelled", reason: "customer closed the shop" } });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
});

test("a check-in AT the customer that says why there was no order closes the order tasks; a far check-in or a made-up reason does not", async () => {
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, sales_channel: "retail" });
  const order = (await give(customer, "make_order")).data;
  const auto = (await pool.query(
    "INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, due_is_next_visit, auto_kind) VALUES ('he stopped ordering', $1, $2, $3, current_date, true, 'reorder_followup') RETURNING id",
    [director.id, rep.id, customer.id]
  )).rows[0];
  const visit = async (extra, { far = false } = {}) => {
    const form = new FormData();
    form.set("customer_id", String(customer.id));
    form.set("lat", String(far ? Number(customer.lat) + 0.5 : customer.lat));
    form.set("lng", String(customer.lng));
    form.set("outcomes", JSON.stringify(["other"]));
    form.set("note", "visit");
    for (const [k, v] of Object.entries(extra)) form.set(k, v);
    const res = await apiFormRequest("/api/checkins", { cookie: repCookie, form });
    if (far) {
      assert.equal(res.status, 422, "a check-in far from the customer is refused: no visit, no reason");
      return;
    }
    assert.equal(res.status, 201, JSON.stringify(res.data));
    trackCheckin(res.data.id);
    await wait(400);
  };
  await visit({ no_order_reason: "closed" }, { far: true });
  assert.equal((await status(order.id)).status, "open");
  await visit({ no_order_reason: "because I said so" });
  assert.equal((await status(order.id)).status, "open", "only the known reasons count");
  await visit({});
  assert.equal((await status(order.id)).status, "open", "a visit without a reason does not close it");
  await visit({ no_order_reason: "no_money" });
  assert.equal((await status(order.id)).status, "done");
  assert.equal((await status(auto.id)).status, "done");
  const { rows: [t] } = await pool.query("SELECT completion_note FROM tasks WHERE id = $1", [order.id]);
  assert.match(t.completion_note, /Փող չկա/);
});

test("a reason given by one rep closes only THAT rep's order tasks, not another rep's task at the same customer", async () => {
  const rep2 = await createUser("sales_manager");
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, sales_channel: "retail" });
  const mine = (await give(customer, "make_order")).data; // a person's task, no automatic task at all
  const theirs = (await apiRequest("/api/tasks", { method: "POST", cookie: dirCookie, body: { title: "other rep", assignee_id: rep2.id, customer_id: customer.id, due_date: due, task_kind: "make_order" } })).data;
  const form = new FormData();
  form.set("customer_id", String(customer.id));
  form.set("lat", String(customer.lat));
  form.set("lng", String(customer.lng));
  form.set("outcomes", JSON.stringify(["other"]));
  form.set("note", "visit");
  form.set("no_order_reason", "stock_full");
  const res = await apiFormRequest("/api/checkins", { cookie: repCookie, form });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackCheckin(res.data.id);
  await wait(400);
  assert.equal((await status(mine.id)).status, "done", "a Make order task closes by the no-order visit too");
  assert.equal((await status(theirs.id)).status, "open", "the other rep did not visit");
  await pool.query("DELETE FROM tasks WHERE assignee_id = $1", [rep2.id]);
});

test("a check-in the server let in because GPS accuracy was forgiven still closes the rep's visit and no-order tasks", async () => {
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, sales_channel: "retail" });
  const visitTask = (await give(customer, "visit_customer")).data;
  const orderTask = (await give(customer, "make_order")).data;
  const form = new FormData();
  form.set("customer_id", String(customer.id));
  form.set("lat", String(Number(customer.lat) + 0.00225)); // about 250 m: more than the 200 m allowance, less than 200 m with 100 m of GPS error forgiven
  form.set("lng", String(customer.lng));
  form.set("accuracy_m", "100");
  form.set("outcomes", JSON.stringify(["other"]));
  form.set("note", "visit");
  form.set("no_order_reason", "closed");
  const res = await apiFormRequest("/api/checkins", { cookie: repCookie, form });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackCheckin(res.data.id);
  assert.equal(res.data.within_range, false, "the raw distance is still saved as it was");
  await wait(400);
  assert.equal((await status(visitTask.id)).status, "done");
  assert.equal((await status(orderTask.id)).status, "done");
});
