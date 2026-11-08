// Owner, 2026-11-05: visit / check-products / collect-debt tasks close ONLY by the work itself; nobody marks them done by hand.
// Management can cancel one with a reason; a debt task takes a recorded result (promised / no answer / refused) and stays open.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, loginAs, apiRequest, apiFormRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { yerevanToday } from "../../src/utils/yerevanDate.js";
import { autoCompleteVisitTasks, autoCompleteProductCheckTasks, autoCompleteCollectionTasks } from "../../src/team/taskAutoComplete.js";

let director;
let rep;
let other;
let dirCookie;
let repCookie;
let customer;

test.before(async () => {
  await startTestServer();
  director = await createUser("sales_director");
  rep = await createUser("sales_manager");
  other = await createUser("sales_manager");
  dirCookie = await loginAs(director.email);
  repCookie = await loginAs(rep.email);
  customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, erp_customer_id: `ITEST-TSC-${Date.now()}` });
});
test.after(async () => {
  await pool.query("DELETE FROM tasks WHERE creator_id = $1", [director.id]);
  await cleanupAll();
  await stopTestServer();
});

const give = async (kind, extra = {}) => {
  const r = await apiRequest("/api/tasks", {
    method: "POST",
    cookie: dirCookie,
    body: { title: `E2E ${kind}`, assignee_id: rep.id, customer_id: customer.id, due_date: yerevanToday(), task_kind: kind, ...extra },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const statusOf = async (id) => (await pool.query("SELECT status, completion_note, outcome, promise_date::text AS promise_date, due_date::text AS due_date FROM tasks WHERE id = $1", [id])).rows[0];

test("a visit / check-products / collect-debt task cannot be marked done by hand, by the rep or by management", async () => {
  for (const kind of ["visit_customer", "check_products", "collect_debt"]) {
    const task = await give(kind);
    const byRep = await apiRequest(`/api/tasks/${task.id}/complete`, { method: "POST", cookie: repCookie, body: {} });
    assert.equal(byRep.status, 409, kind);
    assert.equal(byRep.data.code, "closes_itself");
    const byDirector = await apiRequest(`/api/tasks/${task.id}/complete`, { method: "POST", cookie: dirCookie, body: {} });
    assert.equal(byDirector.status, 409, kind);
    assert.equal((await statusOf(task.id)).status, "open");
  }
});

test("a checklist cannot close a self-closing task either; a plain task still closes by hand", async () => {
  const task = await give("visit_customer", { items: ["Take a photo of the shelf"] });
  const full = (await apiRequest(`/api/tasks/${task.id}`, { cookie: repCookie })).data;
  const tick = await apiRequest(`/api/tasks/${task.id}/items/${full.items[0].id}`, { method: "POST", cookie: repCookie, body: { done: true } });
  assert.equal(tick.status, 200);
  assert.equal((await statusOf(task.id)).status, "open");
  const plain = await apiRequest("/api/tasks", { method: "POST", cookie: dirCookie, body: { title: "E2E plain", assignee_id: rep.id, due_date: yerevanToday() } });
  const done = await apiRequest(`/api/tasks/${plain.data.id}/complete`, { method: "POST", cookie: repCookie, body: {} });
  assert.equal(done.status, 200);
  assert.equal(done.data.status, "done");
});

test("the work itself closes them: a check-in, the shop's products, a payment", async () => {
  const visit = await give("visit_customer");
  await autoCompleteVisitTasks({ customerId: customer.id, actorId: other.id }); // another person's check-in is not this rep's visit
  assert.equal((await statusOf(visit.id)).status, "open");
  await autoCompleteVisitTasks({ customerId: customer.id, actorId: rep.id });
  assert.equal((await statusOf(visit.id)).status, "done");

  const products = await give("check_products");
  await autoCompleteProductCheckTasks({ customerId: customer.id, actorId: rep.id });
  assert.equal((await statusOf(products.id)).status, "done");

  const debt = await give("collect_debt");
  await autoCompleteCollectionTasks({ customerId: customer.id, actorId: rep.id, amountAmd: 50000 });
  assert.equal((await statusOf(debt.id)).status, "done");
});

test("a debt task records what the customer said and stays open; only a promised date moves the deadline", async () => {
  const task = await give("collect_debt");
  const tomorrow = new Date(Date.now() + 4 * 3600 * 1000 + 86400000 * 3).toISOString().slice(0, 10);
  const bad = await apiRequest(`/api/tasks/${task.id}/record-result`, { method: "POST", cookie: repCookie, body: { outcome: "paid" } });
  assert.equal(bad.status, 400); // "paid" is a payment's job, not a button
  const noDate = await apiRequest(`/api/tasks/${task.id}/record-result`, { method: "POST", cookie: repCookie, body: { outcome: "promised" } });
  assert.equal(noDate.status, 400);
  const refused = await apiRequest(`/api/tasks/${task.id}/record-result`, { method: "POST", cookie: repCookie, body: { outcome: "refused", note: "no money this week" } });
  assert.equal(refused.status, 200);
  let row = await statusOf(task.id);
  assert.equal(row.status, "open");
  assert.equal(row.outcome, "refused");
  const promised = await apiRequest(`/api/tasks/${task.id}/record-result`, { method: "POST", cookie: repCookie, body: { outcome: "promised", promise_date: tomorrow } });
  assert.equal(promised.status, 200);
  row = await statusOf(task.id);
  assert.equal(row.status, "open");
  assert.equal(row.promise_date, tomorrow);
  assert.equal(row.due_date, tomorrow);
  // not for other kinds of task
  const plain = await apiRequest("/api/tasks", { method: "POST", cookie: dirCookie, body: { title: "E2E plain 2", assignee_id: rep.id, due_date: yerevanToday() } });
  assert.equal((await apiRequest(`/api/tasks/${plain.data.id}/record-result`, { method: "POST", cookie: repCookie, body: { outcome: "refused" } })).status, 400);
});

test("management cancels a self-closing task with a reason; a rep cannot cancel it", async () => {
  const task = await give("visit_customer");
  const byRep = await apiRequest(`/api/tasks/${task.id}`, { method: "PATCH", cookie: repCookie, body: { status: "cancelled", reason: "I do not want to go" } });
  assert.equal(byRep.status, 403);
  const noReason = await apiRequest(`/api/tasks/${task.id}`, { method: "PATCH", cookie: dirCookie, body: { status: "cancelled" } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.data.code, "reason_required");
  const ok = await apiRequest(`/api/tasks/${task.id}`, { method: "PATCH", cookie: dirCookie, body: { status: "cancelled", reason: "The shop closed down" } });
  assert.equal(ok.status, 200);
  const row = await statusOf(task.id);
  assert.equal(row.status, "cancelled");
  assert.match(row.completion_note, /The shop closed down/);
});

test("a call to a debt customer records what was said and does not close the task", async () => {
  const task = await give("collect_debt");
  const r = await apiRequest(`/api/tasks/${task.id}/call-result`, { method: "POST", cookie: repCookie, body: { result: "spoke", outcome: "refused" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = await statusOf(task.id);
  assert.equal(row.status, "open");
  assert.equal(row.outcome, "refused");
  const paid = await apiRequest(`/api/tasks/${task.id}/call-result`, { method: "POST", cookie: repCookie, body: { result: "spoke", outcome: "paid" } });
  assert.equal(paid.status, 400);
});

test("a check-in far from the customer does not close a visit task (a visit needs the visit)", async () => {
  // management may check in from anywhere; such a check-in is saved as 'not within range' and never counts as the customer's visit
  const far = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id, lat: 40.2, lng: 44.5, erp_customer_id: `ITEST-TSF-${Date.now()}` });
  const task = await apiRequest("/api/tasks", { method: "POST", cookie: dirCookie, body: { title: "E2E far visit", assignee_id: rep.id, customer_id: far.id, due_date: yerevanToday(), task_kind: "visit_customer" } });
  assert.equal(task.status, 201);
  await pool.query("UPDATE tasks SET assignee_id = $2 WHERE id = $1", [task.data.id, director.id]);
  const form = new FormData();
  form.set("customer_id", String(far.id));
  form.set("lat", "41.5");
  form.set("lng", "45.5");
  form.set("outcomes", JSON.stringify(["no_order"]));
  const r = await apiFormRequest("/api/checkins", { cookie: dirCookie, form });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await new Promise((res) => setTimeout(res, 400));
  assert.equal((await statusOf(task.data.id)).status, "open");
  await pool.query("DELETE FROM checkins WHERE id = $1", [r.data.id]);
});
