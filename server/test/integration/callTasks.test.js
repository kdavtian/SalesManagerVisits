// Call and Visit tasks (owner, 2026-10-18): management gives them, the rep records the call result, a check-in closes a visit.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, apiFormRequest, loginAs, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let director, rep, other, dirCookie, repCookie, otherCookie, customer;
test.before(async () => {
  await startTestServer();
  director = await createUser("sales_director");
  rep = await createUser("sales_manager");
  other = await createUser("sales_manager");
  dirCookie = await loginAs(director.email);
  repCookie = await loginAs(rep.email);
  otherCookie = await loginAs(other.email);
  customer = await createCustomer({ created_by: director.id, assigned_manager_id: rep.id });
  await pool.query("UPDATE customers SET phone = $2 WHERE id = $1", [customer.id, "+37491000111"]);
});
test.after(async () => {
  await pool.query("DELETE FROM customer_calls WHERE customer_id = $1", [customer.id]);
  await pool.query("DELETE FROM tasks WHERE assignee_id = ANY($1)", [[rep.id, other.id]]);
  await cleanupAll();
  await stopTestServer();
});

const give = (kind, extra = {}) =>
  apiRequest("/api/tasks", { method: "POST", cookie: dirCookie, body: { title: "T", assignee_id: rep.id, customer_id: customer.id, due_date: "2099-01-01", task_kind: kind, ...extra } });
const result = (id, body, cookie = repCookie) => apiRequest(`/api/tasks/${id}/call-result`, { method: "POST", cookie, body });

test("management can give a Call task: it carries the customer's phone; only management creates", async () => {
  const res = await give("call_customer");
  assert.equal(res.status, 201);
  assert.equal(res.data.task_kind, "call_customer");
  assert.equal(res.data.customer_phone, "+37491000111");
  const noCustomer = await apiRequest("/api/tasks", { method: "POST", cookie: dirCookie, body: { title: "T", assignee_id: rep.id, due_date: "2099-01-01", task_kind: "call_customer" } });
  assert.equal(noCustomer.status, 400);
  const byRep = await apiRequest("/api/tasks", { method: "POST", cookie: repCookie, body: { title: "T", assignee_id: rep.id, customer_id: customer.id, due_date: "2099-01-01", task_kind: "call_customer" } });
  assert.equal(byRep.status, 403);
});

test("call results: no answer keeps the task open, call back moves its date, spoke closes it; every call is a history line", async () => {
  const t = (await give("call_customer")).data;
  assert.equal((await result(t.id, { result: "bogus" })).status, 400);
  assert.equal((await result(t.id, { result: "call_back" })).status, 400, "a call-back needs a date");
  assert.equal((await result(t.id, { result: "call_back", callback_date: "2000-01-01" })).status, 400);
  assert.equal((await result(t.id, { result: "spoke" }, otherCookie)).status >= 400, true, "another rep cannot record it");

  const noAnswer = await result(t.id, { result: "no_answer" });
  assert.equal(noAnswer.status, 200);
  assert.equal(noAnswer.data.status, "open");

  const later = await result(t.id, { result: "call_back", callback_date: "2099-02-02", note: "after lunch" });
  assert.equal(later.data.status, "open");
  assert.equal(later.data.due_date, "2099-02-02");

  const spoke = await result(t.id, { result: "spoke", note: "will order Monday" });
  assert.equal(spoke.status, 200);
  assert.equal(spoke.data.status, "done");
  assert.match(spoke.data.completion_note, /will order Monday/);
  assert.equal((await result(t.id, { result: "spoke" })).status, 409, "closed tasks take no more results");

  const { rows } = await pool.query("SELECT result FROM customer_calls WHERE task_id = $1 ORDER BY id", [t.id]);
  assert.deepEqual(rows.map((r) => r.result), ["no_answer", "call_back", "spoke"]);
  const detail = await apiRequest(`/api/tasks/${t.id}`, { cookie: repCookie });
  assert.equal(detail.data.calls.length, 3);
});

test("a debt call task needs the collection outcome when the customer was spoken to", async () => {
  const t = (await give("collect_debt")).data;
  const noOutcome = await result(t.id, { result: "spoke" });
  assert.equal(noOutcome.status, 400);
  const ok = await result(t.id, { result: "spoke", outcome: "promised", promise_date: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10) });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.outcome, "promised");
});

test("a Visit task closes itself when the assigned rep checks in at the customer; another rep's check-in does not", async () => {
  const t = (await give("visit_customer")).data;
  assert.equal(t.task_kind, "visit_customer");
  const form = (c) => {
    const f = new FormData();
    f.set("customer_id", String(customer.id));
    f.set("lat", String(customer.lat));
    f.set("lng", String(customer.lng));
    f.set("outcomes", JSON.stringify(["no_order"]));
    return f;
  };
  const byOther = await apiFormRequest("/api/checkins", { cookie: otherCookie, form: form() });
  assert.equal(byOther.status, 201, JSON.stringify(byOther.data));
  trackCheckin(byOther.data.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await apiRequest(`/api/tasks/${t.id}`, { cookie: dirCookie })).data.status, "open");
  const byRep = await apiFormRequest("/api/checkins", { cookie: repCookie, form: form() });
  assert.equal(byRep.status, 201, JSON.stringify(byRep.data));
  trackCheckin(byRep.data.id);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await apiRequest(`/api/tasks/${t.id}`, { cookie: dirCookie })).data.status, "done");
});
