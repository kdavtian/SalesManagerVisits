// Automatic "Հավաքագրիր պարտքը" tasks after an ERP sync + night quiet hours.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { createDebtCollectionTasks, autoTaskDiagnostics, debtTaskTitle, DEBT_TASK_TITLE, DEBT_CALL_TITLE } from "../../src/debtCollectionTasks.js";
import { isQuietHours } from "../../src/quietHours.js";

const stamp = Date.now();
const erpIds = [];
let director;
let rep;

test.before(async () => {
  await startTestServer();
  director = await createUser("sales_director");
  rep = await createUser("sales_manager");
});
test.after(async () => {
  await pool.query("DELETE FROM tasks WHERE assignee_id = $1", [rep.id]);
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [erpIds]);
  await cleanupAll();
  await stopTestServer();
});

async function debtor(suffix, { debt, days, channel = "retail" }) {
  const erpId = `ITEST-DT-${suffix}-${stamp}`;
  erpIds.push(erpId);
  const customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, erp_customer_id: erpId, sales_channel: channel });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, days_since_payment, synced_at) VALUES ($1, 'x', $2, $3, now())", [erpId, debt, days]);
  return customer;
}
const openTasks = async (customerId) =>
  (await pool.query("SELECT t.*, (SELECT text FROM task_items WHERE task_id = t.id LIMIT 1) AS item FROM tasks t WHERE customer_id = $1 AND auto_kind = 'debt_collection'", [customerId])).rows;

test("an overdue debtor gets one collect-the-debt task; paid-up, in-term and no-visit-channel customers do not", async () => {
  const overdue = await debtor("a", { debt: 500000, days: 60 });
  const inTerm = await debtor("b", { debt: 500000, days: 10 });
  const paid = await debtor("c", { debt: 0, days: 90 });
  const keyAccount = await debtor("d", { debt: 500000, days: 90, channel: "KF" });
  const cas = await debtor("d2", { debt: 500000, days: 90, channel: "CAS" });
  const oem = await debtor("d3", { debt: 500000, days: 90, channel: "OEM" });

  const first = await createDebtCollectionTasks();
  assert.ok(first.created >= 1);
  const tasks = await openTasks(overdue.id);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /^Հավաքագրիր [\d,]+ դր պարտքը/);
  assert.match(tasks[0].title, /500,000/);
  assert.equal(tasks[0].assignee_id, rep.id);
  assert.equal(tasks[0].due_is_next_visit, true);
  assert.equal((await openTasks(inTerm.id)).length, 0);
  assert.equal((await openTasks(paid.id)).length, 0);
  assert.equal((await openTasks(keyAccount.id)).length, 0);
  assert.equal((await openTasks(cas.id)).length, 0);
  // OEM is not visited in the field: it is chased by a CALL task instead (owner, 2026-10-18)
  const oemTasks = await openTasks(oem.id);
  assert.equal(oemTasks.length, 1);
  assert.equal(oemTasks[0].task_kind, "call_customer");
  assert.equal(oemTasks[0].due_is_next_visit, false);
  assert.match(oemTasks[0].title, /^Զանգահարիր՝ հիշեցրու [\d,]+ դր պարտքի մասին/);
  assert.equal(tasks[0].task_kind, null, "a visited customer still gets the visit task");

  // Running again does not duplicate it.
  await createDebtCollectionTasks();
  assert.equal((await openTasks(overdue.id)).length, 1);

  // The rep got ONE notification for the run.
  const notes = await pool.query("SELECT * FROM notifications WHERE user_id = $1 AND type = 'task_assigned'", [rep.id]);
  assert.equal(notes.rowCount, 1);

  // Closed by the rep: no new task during the cooldown.
  await pool.query("UPDATE tasks SET status = 'done' WHERE customer_id = $1", [overdue.id]);
  await createDebtCollectionTasks();
  assert.equal((await openTasks(overdue.id)).filter((t) => t.status === "open").length, 0);
});

test("CVO and PCO customers are included: their rep gets the task, or the sales director when they have no sales manager", async () => {
  const cvo = await debtor("f", { debt: 400000, days: 80, channel: "CVO" }); // assigned to the rep
  const erpId = `ITEST-DT-g-${stamp}`;
  erpIds.push(erpId);
  const pco = await createCustomer({ created_by: director.id, assigned_manager_id: director.id, erp_customer_id: erpId, sales_channel: "PCO" });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, days_since_payment, synced_at) VALUES ($1, 'x', 300000, 80, now())", [erpId]);
  await createDebtCollectionTasks();
  assert.equal((await openTasks(cvo.id))[0].assignee_id, rep.id);
  assert.equal((await openTasks(cvo.id))[0].task_kind, "call_customer");
  const pcoTasks = await openTasks(pco.id);
  assert.equal(pcoTasks.length, 1);
  assert.equal(pcoTasks[0].assignee_id, director.id);
  await pool.query("DELETE FROM tasks WHERE assignee_id = $1", [director.id]);

  // No sales manager at all: goes to a sales director (Martin when he exists).
  const orphanId = `ITEST-DT-h-${stamp}`;
  erpIds.push(orphanId);
  const orphan = await createCustomer({ created_by: director.id, erp_customer_id: orphanId, sales_channel: "CVO" });
  await pool.query("UPDATE customers SET assigned_manager_id = NULL WHERE id = $1", [orphan.id]);
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, days_since_payment, synced_at) VALUES ($1, 'x', 200000, 80, now())", [orphanId]);
  await createDebtCollectionTasks();
  const orphanTasks = await openTasks(orphan.id);
  assert.equal(orphanTasks.length, 1);
  const { rows: who } = await pool.query("SELECT role FROM users WHERE id = $1", [orphanTasks[0].assignee_id]);
  assert.equal(who[0].role, "sales_director");
  await pool.query("DELETE FROM tasks WHERE customer_id = $1", [orphan.id]);
});

test("the open task closes by itself once the debt is paid", async () => {
  const c = await debtor("e", { debt: 800000, days: 70 });
  await createDebtCollectionTasks();
  assert.equal((await openTasks(c.id)).filter((t) => t.status === "open").length, 1);
  await pool.query("UPDATE erp_customer_data SET debt_amd = 0 WHERE erp_customer_id = $1", [c.erp_customer_id]);
  const res = await createDebtCollectionTasks();
  assert.ok(res.closed >= 1);
  assert.equal((await openTasks(c.id))[0].status, "done");
});

test("quiet hours: no phone push between 22:00 and 07:59 Yerevan", () => {
  assert.equal(isQuietHours(new Date("2026-10-10T17:59:00Z")), false); // 21:59
  assert.equal(isQuietHours(new Date("2026-10-10T18:00:00Z")), true); // 22:00
  assert.equal(isQuietHours(new Date("2026-10-10T20:00:00Z")), true); // 00:00
  assert.equal(isQuietHours(new Date("2026-10-11T03:59:00Z")), true); // 07:59
  assert.equal(isQuietHours(new Date("2026-10-11T04:00:00Z")), false); // 08:00
});

async function order(erpId, orderId, daysAgo, total) {
  await pool.query(
    "INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Yerevan')::date - $3::int, $4)",
    [erpId, orderId, daysAgo, total]
  );
}

test("the debt is overdue only when its OLDEST UNPAID INVOICE is older than the credit term (customer 10365: never paid, last order 11 days ago)", async () => {
  // Never paid ("no payment found"), the whole debt is one order from 11 days ago: not due yet.
  const fresh = await debtor("age-h", { debt: 658000, days: null });
  await order(fresh.erp_customer_id, `H1-${stamp}`, 11, 658000);
  // Paid long ago (80 days), but the debt is again only a recent order: not due yet either.
  const paidLongAgo = await debtor("age-i", { debt: 300000, days: 80 });
  await order(paidLongAgo.erp_customer_id, `I1-${stamp}`, 90, 500000);
  await order(paidLongAgo.erp_customer_id, `I2-${stamp}`, 12, 300000);
  // Debt reaches back to an order 60 days old (older order of 100k is paid, FIFO): overdue, age 60.
  const old = await debtor("age-j", { debt: 400000, days: 5 });
  await order(old.erp_customer_id, `J1-${stamp}`, 100, 100000);
  await order(old.erp_customer_id, `J2-${stamp}`, 60, 250000);
  await order(old.erp_customer_id, `J3-${stamp}`, 10, 300000);
  // Debt larger than the whole order history (opening balance): falls back to the payment rule.
  const opening = await debtor("age-k", { debt: 900000, days: 70 });
  await order(opening.erp_customer_id, `K1-${stamp}`, 5, 100000);

  await createDebtCollectionTasks();
  assert.equal((await openTasks(fresh.id)).length, 0, "never paid but only 11 days old");
  assert.equal((await openTasks(paidLongAgo.id)).length, 0, "paid long ago but the debt is a recent order");
  const oldTasks = await openTasks(old.id);
  assert.equal(oldTasks.length, 1);
  assert.match(oldTasks[0].title, /60 օր/);
  assert.equal((await openTasks(opening.id)).length, 1);

  // Once the 11-day-old order passes the 45-day term the task appears.
  await pool.query("UPDATE erp_order_lines SET order_date = order_date - 40 WHERE erp_customer_id = $1", [fresh.erp_customer_id]);
  await createDebtCollectionTasks();
  assert.equal((await openTasks(fresh.id)).length, 1);
});

test("an open task whose debt is not overdue by the invoice-age rule is cancelled, not reported as paid", async () => {
  const c = await debtor("age-m", { debt: 200000, days: null });
  await order(c.erp_customer_id, `M1-${stamp}`, 100, 200000); // old enough: overdue, gets a task
  await createDebtCollectionTasks();
  assert.equal((await openTasks(c.id)).length, 1);
  await pool.query("UPDATE erp_order_lines SET order_date = order_date + 90 WHERE erp_customer_id = $1", [c.erp_customer_id]); // now 10 days old
  await createDebtCollectionTasks();
  const t = (await openTasks(c.id))[0];
  assert.equal(t.status, "cancelled");
  assert.equal(t.outcome, null);
  await pool.query("UPDATE erp_customer_data SET debt_amd = 0 WHERE erp_customer_id = $1", [c.erp_customer_id]);
});

// ---- tasks must close themselves when the ERP shows the customer paid (customer 10167: bank transfer, never closed) ----
const withFillerRows = async (n, fn) => {
  const fillers = Array.from({ length: n }, (_, i) => `ITEST-FILL-${i}-${stamp}`);
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at) SELECT x, 'filler', 0, now() FROM unnest($1::text[]) x", [fillers]);
  try {
    return await fn();
  } finally {
    await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [fillers]);
  }
};

test("a customer who paid up and DROPPED OUT of the ERP extract: the open task closes as paid (only when the extract is a real one)", async () => {
  const c = await debtor("drop", { debt: 900000, days: 70 });
  await createDebtCollectionTasks();
  assert.equal((await openTasks(c.id)).filter((t) => t.status === "open").length, 1);
  // the next sync no longer contains the customer
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [c.erp_customer_id]);
  // a nearly empty extract proves nothing: the task stays
  await createDebtCollectionTasks();
  assert.equal((await openTasks(c.id))[0].status, "open", "too few customers in the extract to trust the absence");
  // a normal extract: gone from it = paid up
  await withFillerRows(25, () => createDebtCollectionTasks());
  const t = (await openTasks(c.id))[0];
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "paid");
  assert.match(t.completion_note, /Excel/);
});

test("a bank transfer clears the overdue invoices but newer ones remain: the task is DONE (paid), not cancelled", async () => {
  const c = await debtor("bank", { debt: 300000, days: null });
  await order(c.erp_customer_id, `BK1-${stamp}`, 100, 300000); // old and unpaid: overdue
  await createDebtCollectionTasks();
  assert.equal((await openTasks(c.id)).filter((t) => t.status === "open").length, 1);
  // the old invoice is paid by bank transfer (ERP cashflow today); a fresh invoice of the same size is now the whole debt
  await pool.query("UPDATE erp_order_lines SET order_date = order_date + 95 WHERE erp_customer_id = $1", [c.erp_customer_id]);
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, (now() AT TIME ZONE 'Asia/Yerevan')::date, 300000)", [c.erp_customer_id]);
  await createDebtCollectionTasks();
  const t = (await openTasks(c.id))[0];
  assert.equal(t.status, "done");
  assert.equal(t.outcome, "paid");
  await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [c.erp_customer_id]);
});

test("a stopped-ordering task closes when the customer orders through the workbook (not only through the app)", async () => {
  const { createReorderFollowupTasks } = await import("../../src/debtCollectionTasks.js");
  const c = await debtor("reord", { debt: 0, days: 5 });
  const { rows } = await pool.query(
    "INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date, due_is_next_visit, auto_kind, created_at) VALUES ('ro', $1, $2, $3, current_date, true, 'reorder_followup', now() - interval '2 days') RETURNING id",
    [director.id, rep.id, c.id]
  );
  await createReorderFollowupTasks(new Date(), { notify: false });
  assert.equal((await pool.query("SELECT status FROM tasks WHERE id = $1", [rows[0].id])).rows[0].status, "open", "no order yet");
  await order(c.erp_customer_id, `RO1-${stamp}`, 0, 120000);
  await pool.query("UPDATE erp_order_lines SET qty = 4 WHERE erp_customer_id = $1", [c.erp_customer_id]);
  await createReorderFollowupTasks(new Date(), { notify: false });
  assert.equal((await pool.query("SELECT status FROM tasks WHERE id = $1", [rows[0].id])).rows[0].status, "done");
});

test("the task title is plain words with the days late and the date of the last payment", () => {
  assert.equal(
    debtTaskTitle({ call: false, debt: 2420000, daysOpen: 94, termDays: 45, lastPayment: "2026-10-23", promiseBroken: false }),
    "Հավաքագրիր 2,420,000 դր պարտքը (94 օրվա հաշիվ, ժամկետից 49 օր ուշացում), վերջին վճարումը արվել է 23.10.2026-ին"
  );
  assert.equal(debtTaskTitle({ call: true, debt: 500000, daysOpen: null, lastPayment: null, promiseBroken: true }), "Զանգահարիր՝ հիշեցրու 500,000 դր պարտքի մասին · խոստումը չի կատարվել");
});

test("the diagnostics put every overdue customer in exactly one line and say who is waiting", async () => {
  const waiting = await debtor("diag1", { debt: 700000, days: 80 });
  const kf = await debtor("diag2", { debt: 700000, days: 80, channel: "KF" });
  const before = await autoTaskDiagnostics();
  const sum = before.channel_skipped + before.on_hold + before.has_open + before.promise_running + before.cooling + before.no_rep + before.ready;
  assert.equal(sum, before.overdue_total);
  assert.ok(before.channel_skipped >= 1);
  assert.ok(before.ready >= 1);
  await createDebtCollectionTasks();
  const after = await autoTaskDiagnostics();
  assert.ok(after.has_open >= 1);
  assert.ok(after.tasks.debt_collection.last_7_days >= 1);
  assert.ok(waiting.id && kf.id);
});
