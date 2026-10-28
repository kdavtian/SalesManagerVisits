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
