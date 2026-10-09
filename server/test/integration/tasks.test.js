// Task management: who may create / assign, the checklist, completion
// notifications, the Map customer flags and the 09:30 deadline reminder.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, loginAs, apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { sendDeadlineReminders } from "../../src/taskReminders.js";
import { yerevanToday } from "../../src/utils/yerevanDate.js";

let users;
let cookies;
let customer;

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "ceo", "sales_director", "sales_manager", "accountant"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
  users.manager2 = await createUser("sales_manager");
  cookies.manager2 = await loginAs(users.manager2.email);
  customer = await createCustomer({ created_by: users.sales_director.id, assigned_manager_id: users.sales_manager.id });
});
test.after(async () => {
  await pool.query("DELETE FROM tasks WHERE creator_id = ANY($1)", [Object.values(users).map((u) => u.id)]);
  await cleanupAll();
  await stopTestServer();
});

const notificationsFor = async (userId, type) =>
  (await pool.query("SELECT * FROM notifications WHERE user_id = $1 AND type = $2", [userId, type])).rows;

// notifyUser() is fire-and-forget in the route, so a row can land a few ms after the response.
const waitForNotifications = async (userId, type, count = 1) => {
  for (let i = 0; i < 40; i++) {
    const rows = await notificationsFor(userId, type);
    if (rows.length >= count) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return notificationsFor(userId, type);
};

test("only management creates tasks; a sales director assigns to sales managers only, the CEO to anyone", async () => {
  const body = (assignee) => ({ title: "Tell Aram about ON EV", assignee_id: assignee.id, due_date: yerevanToday(), items: ["Show the leaflet"] });
  const asManager = await apiRequest("/api/tasks", { method: "POST", cookie: cookies.sales_manager, body: body(users.manager2) });
  assert.equal(asManager.status, 403);
  const toCeo = await apiRequest("/api/tasks", { method: "POST", cookie: cookies.sales_director, body: body(users.ceo) });
  assert.equal(toCeo.status, 403);
  const ok = await apiRequest("/api/tasks", { method: "POST", cookie: cookies.sales_director, body: body(users.sales_manager) });
  assert.equal(ok.status, 201);
  const ceoToAccountant = await apiRequest("/api/tasks", { method: "POST", cookie: cookies.ceo, body: body(users.accountant) });
  assert.equal(ceoToAccountant.status, 201);

  const assignees = await apiRequest("/api/tasks/assignees", { cookie: cookies.sales_director });
  assert.ok(assignees.data.every((u) => u.role === "sales_manager"));
  assert.deepEqual((await apiRequest("/api/tasks/assignees", { cookie: cookies.sales_manager })).data, []);

  const missing = await apiRequest("/api/tasks", { method: "POST", cookie: cookies.ceo, body: { assignee_id: users.sales_manager.id, due_date: yerevanToday() } });
  assert.equal(missing.status, 400, "a title is required");
});

test("assignee is notified, sees the task, ticks the checklist, and completing notifies the creator", async () => {
  const created = await apiRequest("/api/tasks", {
    method: "POST",
    cookie: cookies.sales_director,
    body: { title: "Present ON EV range", assignee_id: users.sales_manager.id, customer_id: customer.id, due_date: yerevanToday(), due_is_next_visit: true, items: ["Leaflet", "Price list"] },
  });
  assert.equal(created.status, 201);
  const task = created.data;
  assert.equal(task.customer_name, customer.name);
  assert.equal(task.items.length, 2);
  assert.equal((await waitForNotifications(users.sales_manager.id, "task_assigned")).length >= 1, true);

  const mine = await apiRequest("/api/tasks?scope=mine&due=today", { cookie: cookies.sales_manager });
  assert.ok(mine.data.rows.some((t) => t.id === task.id));
  // Another rep does not see it.
  const other = await apiRequest("/api/tasks?scope=mine", { cookie: cookies.manager2 });
  assert.ok(!other.data.rows.some((t) => t.id === task.id));
  assert.equal((await apiRequest(`/api/tasks/${task.id}`, { cookie: cookies.accountant })).status, 404);

  const flags = await apiRequest("/api/tasks/customer-flags", { cookie: cookies.sales_manager });
  assert.equal(flags.data.find((f) => f.customer_id === customer.id)?.due, true);

  // Tick item 1: still open. Tick item 2: auto-completes.
  const after1 = await apiRequest(`/api/tasks/${task.id}/items/${task.items[0].id}`, { method: "POST", cookie: cookies.sales_manager, body: { done: true } });
  assert.equal(after1.data.status, "open");
  const after2 = await apiRequest(`/api/tasks/${task.id}/items/${task.items[1].id}`, { method: "POST", cookie: cookies.sales_manager, body: { done: true } });
  assert.equal(after2.data.status, "done");
  assert.equal((await waitForNotifications(users.sales_director.id, "task_completed")).length, 1);
  // Done tasks leave the Map flags and the open list; unticking reopens.
  const flagsAfter = await apiRequest("/api/tasks/customer-flags", { cookie: cookies.sales_manager });
  assert.ok(!flagsAfter.data.some((f) => f.customer_id === customer.id));
  const reopened = await apiRequest(`/api/tasks/${task.id}/items/${task.items[0].id}`, { method: "POST", cookie: cookies.sales_manager, body: { done: false } });
  assert.equal(reopened.data.status, "open");
});

test("only the creator edits or cancels; the assignee can complete a checklist-free task", async () => {
  const created = await apiRequest("/api/tasks", {
    method: "POST",
    cookie: cookies.sales_director,
    body: { title: "Call about debt", assignee_id: users.sales_manager.id, due_date: yerevanToday() },
  });
  const id = created.data.id;
  assert.equal((await apiRequest(`/api/tasks/${id}`, { method: "PATCH", cookie: cookies.sales_manager, body: { title: "x" } })).status, 403);
  const edited = await apiRequest(`/api/tasks/${id}`, { method: "PATCH", cookie: cookies.sales_director, body: { title: "Call about debt today", items: ["Ask for payment date"] } });
  assert.equal(edited.data.title, "Call about debt today");
  assert.equal(edited.data.items.length, 1);
  const done = await apiRequest(`/api/tasks/${id}/complete`, { method: "POST", cookie: cookies.sales_manager, body: { note: "Customer will pay Friday" } });
  assert.equal(done.data.status, "done");
  assert.equal(done.data.completion_note, "Customer will pay Friday");
  const cancelled = await apiRequest(`/api/tasks/${id}`, { method: "PATCH", cookie: cookies.sales_director, body: { status: "cancelled" } });
  assert.equal(cancelled.data.status, "cancelled");
});

test("09:30 deadline reminder goes out once, only after 09:30 Yerevan, only for open tasks due that day", async () => {
  const created = await apiRequest("/api/tasks", {
    method: "POST",
    cookie: cookies.ceo,
    body: { title: "Reminder test", assignee_id: users.accountant.id, due_date: yerevanToday() },
  });
  const id = created.data.id;
  const today = yerevanToday();
  const early = new Date(`${today}T04:00:00Z`); // 08:00 Yerevan
  const late = new Date(`${today}T06:30:00Z`); // 10:30 Yerevan
  const reminders = async () => (await notificationsFor(users.accountant.id, "task_deadline")).filter((n) => n.url.includes(`open=${id}`)).length;
  await sendDeadlineReminders(early);
  assert.equal(await reminders(), 0, "nothing before 09:30");
  await sendDeadlineReminders(late);
  assert.equal(await reminders(), 1);
  await sendDeadlineReminders(late);
  assert.equal(await reminders(), 1, "only once per day");
});
