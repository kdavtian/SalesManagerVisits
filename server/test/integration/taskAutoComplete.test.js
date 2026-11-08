// Automatic tasks close themselves when the rep does what they ask, and everything an ERP sync
// produces reaches a person as ONE notification.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, apiRequest, apiFormRequest, loginAs, trackCheckin, trackOrder } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { createDebtCollectionTasks, createReorderFollowupTasks } from "../../src/money/debtCollectionTasks.js";
import { queueReportLabel, queueSyncNotice, flushSyncNotices } from "../../src/erp/syncNotifier.js";

const stamp = Date.now();
const erpIds = [];
let director, rep, repCookie;

test.before(async () => {
  await startTestServer();
  director = await createUser("sales_director");
  rep = await createUser("sales_manager");
  repCookie = await loginAs(rep.email);
});
test.after(async () => {
  await pool.query("DELETE FROM tasks WHERE assignee_id = $1", [rep.id]);
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM payments WHERE sales_manager_id = $1", [rep.id]);
  await cleanupAll();
  await stopTestServer();
});

async function debtor(suffix, debt) {
  const erpId = `ITEST-TAC-${suffix}-${stamp}`;
  erpIds.push(erpId);
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, erp_customer_id: erpId, sales_channel: "retail" });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, days_since_payment, synced_at) VALUES ($1, 'x', $2, 90, now())", [erpId, debt]);
  return customer;
}
const task = async (customerId, kind) => (await pool.query("SELECT * FROM tasks WHERE customer_id = $1 AND auto_kind = $2 ORDER BY id DESC LIMIT 1", [customerId, kind])).rows[0];
const notified = async (userId, type) => (await pool.query("SELECT * FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY id DESC", [userId, type])).rows;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("money collected on a visit closes the debt task: partial when it does not cover the debt, and the rep is told", async () => {
  const customer = await debtor("a", 200000);
  await createDebtCollectionTasks();
  assert.equal((await task(customer.id, "debt_collection")).status, "open");

  const form = new FormData();
  form.set("customer_id", String(customer.id));
  form.set("lat", String(customer.lat));
  form.set("lng", String(customer.lng));
  form.set("outcomes", JSON.stringify(["payment_collected"]));
  form.set("amount_collected_amd", "50000");
  const res = await apiFormRequest("/api/checkins", { cookie: repCookie, form });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  trackCheckin(res.data.id);
  await wait(400);

  const t = await task(customer.id, "debt_collection");
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "partial");
  assert.equal(t.completed_by, rep.id);
  assert.match(t.completion_note, /50,000/);
  const n = (await notified(rep.id, "task_completed")).find((x) => x.url === `/#/tasks?open=${t.id}`);
  assert.ok(n, "the assignee gets a notification");
  assert.match(n.body, /50,000/);
});

test("a payment that covers the whole debt closes the task as paid (payment recorded in the Payments tab)", async () => {
  const customer = await debtor("b", 80000);
  await createDebtCollectionTasks();
  const res = await apiRequest("/api/payments", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, amount_amd: 80000 } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  await wait(400);
  const t = await task(customer.id, "debt_collection");
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "paid");
});

test("an order for the customer closes the reorder task", async () => {
  const erpId = `ITEST-TAC-r-${stamp}`;
  erpIds.push(erpId);
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, erp_customer_id: erpId, sales_channel: "retail" });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at) VALUES ($1, 'x', 0, now())", [erpId]);
  // Usual rhythm: an order every 14 days, the last one 80 days ago -> a reorder follow-up task.
  for (const ago of [150, 136, 122, 108, 94, 80]) {
    await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Yerevan')::date - $3::int, 1000)", [erpId, `R${ago}-${stamp}`, ago]);
  }
  await createReorderFollowupTasks();
  assert.equal((await task(customer.id, "reorder_followup")).status, "open");

  const product = await createProduct({ unit_price_amd: 1000 });
  const o = await apiRequest("/api/orders", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, items: [{ product_id: product.id, quantity: 2 }], payment_method: "cash" } });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  trackOrder(o.data.id);
  await wait(400);
  const t = await task(customer.id, "reorder_followup");
  assert.equal(t.status, "done");
  assert.match(t.completion_note, /Ավտոմատ/);
});

test("one sync run = one notification per person, with a line per effect and their preferences respected", async () => {
  const marker = (await pool.query("SELECT COALESCE(max(id), 0) AS m FROM notifications")).rows[0].m;
  queueReportLabel("Օրական հաշվետվություն");
  queueSyncNotice({ type: "price_changed", roles: ["sales_manager", "sales_director"], text: "3 ապրանքի գինը փոխվել է", url: "/#/pricelist", order: 2 });
  queueSyncNotice({ type: "task_assigned", userIds: [rep.id], text: "2 նոր առաջադրանք", url: "/#/tasks", order: 3 });
  await flushSyncNotices();

  const since = async (userId) => (await pool.query("SELECT * FROM notifications WHERE user_id = $1 AND id > $2 AND type IN ('sync_reports_ready','price_changed','task_assigned')", [userId, marker])).rows;
  const dir = await since(director.id);
  assert.equal(dir.length, 1, "the sales director gets reports + prices as ONE notification");
  assert.match(dir[0].body, /Օրական հաշվետվություն/);
  assert.match(dir[0].body, /3 ապրանքի/);
  const mine = await since(rep.id);
  assert.equal(mine.length, 1, "the rep gets prices + tasks as ONE notification (no reports line)");
  assert.match(mine[0].body, /3 ապրանքի/);
  assert.match(mine[0].body, /2 նոր առաջադրանք/);
  assert.doesNotMatch(mine[0].body, /Օրական հաշվետվություն/);
});

// Owner, 2026-11-08: "there was a task of debt collection for 10136 on 10/10/2026 and there were payments after that, but the task wasn't
// closed by itself". The app closes a task for ANY amount it records itself; the nightly Excel check closed it only when the whole overdue
// debt was gone. A payment that reached the Excel (cashflow line / last payment date) while money is still owed must close it too.
const today = () => new Date(Date.now() + 4 * 3600000).toISOString().slice(0, 10);
const manualTask = async (customerId, taskKind) =>
  (await pool.query(
    "INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, task_kind) VALUES ($1, $2, $3, $4, current_date + 3, $5) RETURNING id",
    [`manual ${taskKind}`, director.id, rep.id, customerId, taskKind]
  )).rows[0].id;
const madeDaysAgo = (id, days) => pool.query("UPDATE tasks SET created_at = now() - ($2 || ' days')::interval WHERE id = $1", [id, String(days)]);
const taskById = async (id) => (await pool.query("SELECT * FROM tasks WHERE id = $1", [id])).rows[0];

test("a payment in the Excel after the task was made closes it (partial) even though overdue money is left", async () => {
  const customer = await debtor("xp", 200000);
  await createDebtCollectionTasks();
  const open = await task(customer.id, "debt_collection");
  assert.equal(open.status, "open");
  await madeDaysAgo(open.id, 3);
  // 50,000 is paid and recorded in the workbook's cashflow; 150,000 is still owed and overdue (days_since_payment 90, term 45)
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, $2, 50000)", [customer.erp_customer_id, today()]);
  await pool.query("UPDATE erp_customer_data SET debt_amd = 150000 WHERE erp_customer_id = $1", [customer.erp_customer_id]);
  const marker = (await pool.query("SELECT COALESCE(max(id), 0) AS m FROM notifications")).rows[0].m;
  await createDebtCollectionTasks();
  const t = await taskById(open.id);
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "partial");
  assert.match(t.completion_note, /Excel/);
  assert.ok((await notified(rep.id, "task_completed")).some((n) => n.id > marker), "the rep is told it closed itself");
});

test("a payment that clears the debt through the Excel's last payment date closes it as paid", async () => {
  const customer = await debtor("xq", 90000);
  await createDebtCollectionTasks();
  const open = await task(customer.id, "debt_collection");
  assert.equal(open.status, "open");
  await madeDaysAgo(open.id, 3);
  await pool.query("UPDATE erp_customer_data SET debt_amd = 0, last_payment_date = $2 WHERE erp_customer_id = $1", [customer.erp_customer_id, today()]);
  await createDebtCollectionTasks();
  const t = await taskById(open.id);
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "paid");
});

test("a payment from BEFORE the task does not close it", async () => {
  const customer = await debtor("xr", 120000);
  await createDebtCollectionTasks();
  const open = await task(customer.id, "debt_collection");
  await pool.query("UPDATE tasks SET created_at = now() - interval '3 days' WHERE id = $1", [open.id]);
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, $2::date - 10, 40000)", [customer.erp_customer_id, today()]);
  await createDebtCollectionTasks();
  assert.equal((await taskById(open.id)).status, "open");
});

test("a debt task given by a person (type 'Collect debt') closes the same way when the Excel shows a payment after it", async () => {
  const customer = await debtor("xm", 100000);
  const id = await manualTask(customer.id, "collect_debt");
  await madeDaysAgo(id, 3);
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, $2, 30000)", [customer.erp_customer_id, today()]);
  await pool.query("UPDATE erp_customer_data SET debt_amd = 70000 WHERE erp_customer_id = $1", [customer.erp_customer_id]);
  await createDebtCollectionTasks();
  const t = await taskById(id);
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "partial");
});

test("an order that reaches the Excel closes the 'Make an order' task a person gave, like the automatic one", async () => {
  const erpId = `ITEST-TAC-mo-${stamp}`;
  erpIds.push(erpId);
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, erp_customer_id: erpId, sales_channel: "retail" });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at) VALUES ($1, 'x', 0, now())", [erpId]);
  const id = await manualTask(customer.id, "make_order");
  await madeDaysAgo(id, 3);
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, qty, revenue_amd) VALUES ($1, $2, $3, 2, 5000)", [erpId, `MO-${stamp}`, today()]);
  await createReorderFollowupTasks();
  assert.equal((await taskById(id)).status, "done");
});

test("a payment dated the task's own day (it may have come BEFORE the task) does not close it; neither does an order of that day for a person's task", async () => {
  const customer = await debtor("sd", 100000);
  await createDebtCollectionTasks();
  const open = await task(customer.id, "debt_collection");
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, $2, 10000)", [customer.erp_customer_id, today()]);
  await createDebtCollectionTasks();
  assert.equal((await taskById(open.id)).status, "open", "same day: only the app's own event closes it");
  const erpId = `ITEST-TAC-sdo-${stamp}`;
  erpIds.push(erpId);
  const shop = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, erp_customer_id: erpId, sales_channel: "retail" });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at) VALUES ($1, 'x', 0, now())", [erpId]);
  const orderTask = await manualTask(shop.id, "make_order");
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, qty, revenue_amd) VALUES ($1, $2, $3, 2, 5000)", [erpId, `SD-${stamp}`, today()]);
  await createReorderFollowupTasks();
  assert.equal((await taskById(orderTask)).status, "open");
});

test("a task with a promise still running keeps it when a payment shows; a customer with no Excel row is never closed as paid", async () => {
  const customer = await debtor("pr", 100000);
  await createDebtCollectionTasks();
  const open = await task(customer.id, "debt_collection");
  await madeDaysAgo(open.id, 3);
  await pool.query("UPDATE tasks SET outcome = 'promised', promise_date = $2::date + 5 WHERE id = $1", [open.id, today()]);
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, $2, 10000)", [customer.erp_customer_id, today()]);
  await createDebtCollectionTasks();
  const t = await taskById(open.id);
  assert.equal(t.status, "open", "the promise is kept");
  assert.equal(t.outcome, "promised");
  // no Excel row for the customer at all, only a cashflow line: no proof that the debt is gone
  const erpId = `ITEST-TAC-nr-${stamp}`;
  erpIds.push(erpId);
  const shop = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, erp_customer_id: erpId, sales_channel: "retail" });
  const id = await manualTask(shop.id, "collect_debt");
  await madeDaysAgo(id, 3);
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, $2, 5000)", [erpId, today()]);
  await createDebtCollectionTasks();
  assert.equal((await taskById(id)).status, "open");
});

test("the notifications of a sync run are not sent task by task: a run with notify off closes quietly, a run with notify on tells the rep and the person who gave the task", async () => {
  const customer = await debtor("nq", 100000);
  const id = await manualTask(customer.id, "collect_debt");
  await madeDaysAgo(id, 3);
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, $2, 20000)", [customer.erp_customer_id, today()]);
  const marker = (await pool.query("SELECT COALESCE(max(id), 0) AS m FROM notifications")).rows[0].m;
  await createDebtCollectionTasks(new Date(), { notify: false });
  assert.equal((await taskById(id)).status, "done");
  assert.equal((await notified(rep.id, "task_completed")).filter((n) => n.id > marker).length, 0, "a sync run says nothing task by task");
  const customer2 = await debtor("nr2", 100000);
  const id2 = await manualTask(customer2.id, "collect_debt");
  await madeDaysAgo(id2, 3);
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, $2, 20000)", [customer2.erp_customer_id, today()]);
  await createDebtCollectionTasks(new Date(), { notify: true });
  assert.equal((await taskById(id2)).status, "done");
  assert.ok((await notified(rep.id, "task_completed")).some((n) => n.id > marker), "the rep is told");
  assert.ok((await notified(director.id, "task_completed")).some((n) => n.id > marker), "the person who gave the task is told");
});

// Owner, 2026-11-08: after a payment closes the task, Vaghinak can make a new task with a new deadline if overdue money is still left.
test("a partial payment closes the debt task and the next run makes a NEW task for what is still overdue (no 14-day pause after a payment)", async () => {
  const customer = await debtor("fu", 200000);
  await createDebtCollectionTasks();
  const first = await task(customer.id, "debt_collection");
  assert.equal(first.status, "open");
  const res = await apiRequest("/api/payments", { method: "POST", cookie: repCookie, body: { customer_id: customer.id, amount_amd: 50000 } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  await wait(400);
  assert.equal((await taskById(first.id)).status, "done");
  assert.equal((await taskById(first.id)).outcome, "partial");
  await createDebtCollectionTasks(); // the next night: 150,000 of overdue money is left
  const next = await task(customer.id, "debt_collection");
  assert.notEqual(next.id, first.id, "a new task");
  assert.equal(next.status, "open");
  assert.equal(next.assignee_id, rep.id);
});

test("a task nobody acted on still holds the next one back for the pause, and so does one management cancelled", async () => {
  const customer = await debtor("fq", 120000);
  await createDebtCollectionTasks();
  const first = await task(customer.id, "debt_collection");
  await pool.query("UPDATE tasks SET status = 'cancelled' WHERE id = $1", [first.id]);
  await createDebtCollectionTasks();
  const latest = await task(customer.id, "debt_collection");
  assert.equal(latest.id, first.id, "no new task inside the pause");
});
