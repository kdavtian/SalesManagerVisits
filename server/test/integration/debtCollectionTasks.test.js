// Automatic "Հավաքագրիր պարտքը" tasks after an ERP sync + night quiet hours.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { createDebtCollectionTasks, DEBT_TASK_TITLE } from "../../src/debtCollectionTasks.js";
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
  assert.equal(tasks[0].title, DEBT_TASK_TITLE);
  assert.equal(tasks[0].assignee_id, rep.id);
  assert.equal(tasks[0].due_is_next_visit, true);
  assert.match(tasks[0].item, /500,000/);
  assert.equal((await openTasks(inTerm.id)).length, 0);
  assert.equal((await openTasks(paid.id)).length, 0);
  assert.equal((await openTasks(keyAccount.id)).length, 0);
  assert.equal((await openTasks(cas.id)).length, 0);
  assert.equal((await openTasks(oem.id)).length, 0);

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
