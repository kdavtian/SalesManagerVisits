// Deleting a person keeps their tasks (owner, 2026-10-29: "the tasks remain"): what they created or were given passes to the next manager
// (src/team/taskHandover.js) instead of disappearing with them (tasks.creator_id / assignee_id are ON DELETE CASCADE).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let admin, adminCookie;
const taskIds = [];

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
});
test.after(async () => {
  await pool.query("DELETE FROM tasks WHERE id = ANY($1)", [taskIds]);
  await cleanupAll();
  await stopTestServer();
});

async function addTask(creatorId, assigneeId, status = "open") {
  const { rows } = await pool.query(
    "INSERT INTO tasks (title, creator_id, assignee_id, due_date, status) VALUES ('Handover test', $1, $2, CURRENT_DATE, $3) RETURNING id",
    [creatorId, assigneeId, status]
  );
  taskIds.push(rows[0].id);
  return rows[0].id;
}
const taskRow = async (id) => (await pool.query("SELECT * FROM tasks WHERE id = $1", [id])).rows[0];
const managers = new Set(["sales_director", "ceo", "admin"]);
const roleOf = async (id) => (await pool.query("SELECT role FROM users WHERE id = $1", [id])).rows[0]?.role;

test("deleting a director keeps the tasks they created and were given: they pass to another manager", async () => {
  const director = await createUser("sales_director");
  const rep = await createUser("sales_manager");
  const created = await addTask(director.id, rep.id); // e.g. an automatic debt task, "created" by the director
  const given = await addTask(admin.id, director.id); // a task the director had to do
  const done = await addTask(admin.id, director.id, "done");

  const res = await apiRequest(`/api/users/${director.id}`, { method: "DELETE", cookie: adminCookie });
  assert.equal(res.status, 204, JSON.stringify(res.data));
  assert.equal((await pool.query("SELECT 1 FROM users WHERE id = $1", [director.id])).rowCount, 0, "the account is gone");

  const a = await taskRow(created);
  assert.ok(a, "the task the director created is still there");
  assert.notEqual(a.creator_id, director.id);
  assert.ok(managers.has(await roleOf(a.creator_id)), "it now names another manager as creator");
  assert.equal(a.assignee_id, rep.id, "the rep still has it");
  const b = await taskRow(given);
  assert.ok(b && b.status === "open", "the director's own open task is still open");
  assert.ok(managers.has(await roleOf(b.assignee_id)));
  assert.ok(await taskRow(done), "a finished task stays in the history");
});

test("deleting a rep keeps their open task, now with a manager", async () => {
  const rep = await createUser("sales_manager");
  const id = await addTask(admin.id, rep.id);
  const res = await apiRequest(`/api/users/${rep.id}`, { method: "DELETE", cookie: adminCookie });
  assert.equal(res.status, 204, JSON.stringify(res.data));
  const t = await taskRow(id);
  assert.ok(t && t.status === "open");
  assert.ok(managers.has(await roleOf(t.assignee_id)));
});

test("the test-user purge keeps the tasks too", async () => {
  const testUser = await createUser("sales_manager", { name: "Purge Test Rep" });
  const id = await addTask(admin.id, testUser.id);
  const res = await apiRequest(`/api/users/${testUser.id}/purge`, { method: "POST", cookie: adminCookie, body: { confirm: true } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const t = await taskRow(id);
  assert.ok(t, "the task is still there");
  assert.notEqual(t.assignee_id, testUser.id);
});

test("an invalid id is refused before anything is touched", async () => {
  const res = await apiRequest("/api/users/abc", { method: "DELETE", cookie: adminCookie });
  assert.equal(res.status, 400);
});
