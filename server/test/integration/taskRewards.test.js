// The "well done" moment (migration 195): a finished task is shown to its assignee ONCE. The server keeps what was not seen yet.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const stamp = Date.now();
let director, rep, other, dirCookie, repCookie, otherCookie;

test.before(async () => {
  await startTestServer();
  director = await createUser("sales_director");
  rep = await createUser("sales_manager");
  other = await createUser("sales_manager");
  dirCookie = await loginAs(director.email);
  repCookie = await loginAs(rep.email);
  otherCookie = await loginAs(other.email);
});
test.after(async () => {
  await pool.query("DELETE FROM tasks WHERE assignee_id = ANY($1)", [[rep.id, other.id]]);
  await cleanupAll();
  await stopTestServer();
});

const due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const give = async (who = rep) => (await apiRequest("/api/tasks", { method: "POST", cookie: dirCookie, body: { title: `R-${stamp}-${Math.random()}`, assignee_id: who.id, due_date: due } })).data;

test("a task finished by someone else is a reward for the assignee, shown once", async () => {
  const task = await give();
  await pool.query("UPDATE tasks SET status = 'done', completed_at = now(), completed_by = $2 WHERE id = $1", [task.id, director.id]);
  const first = await apiRequest("/api/tasks/rewards", { cookie: repCookie });
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.rewards.map((r) => r.id), [task.id]);
  assert.ok(first.data.stats.done_week >= 1);
  assert.equal(typeof first.data.stats.open_left, "number");
  const seen = await apiRequest("/api/tasks/rewards/seen", { method: "POST", cookie: repCookie, body: { ids: [task.id] } });
  assert.equal(seen.data.marked, 1);
  assert.equal((await apiRequest("/api/tasks/rewards", { cookie: repCookie })).data.rewards.length, 0, "never twice");
  assert.equal((await apiRequest("/api/tasks/rewards/seen", { method: "POST", cookie: repCookie, body: { ids: [task.id] } })).data.marked, 0);
});

test("another person never sees or marks my reward", async () => {
  const task = await give();
  await pool.query("UPDATE tasks SET status = 'done', completed_at = now(), completed_by = $2 WHERE id = $1", [task.id, director.id]);
  assert.equal((await apiRequest("/api/tasks/rewards", { cookie: otherCookie })).data.rewards.length, 0);
  assert.equal((await apiRequest("/api/tasks/rewards/seen", { method: "POST", cookie: otherCookie, body: { ids: [task.id] } })).data.marked, 0);
  assert.equal((await apiRequest("/api/tasks/rewards", { cookie: repCookie })).data.rewards.length, 1, "still waiting for its owner");
  await pool.query("UPDATE tasks SET reward_seen_at = now() WHERE id = $1", [task.id]);
});

test("finishing a task by hand counts as seen (the confirmation was shown on the spot); reopen + finish again is a new moment", async () => {
  const task = await give();
  const done = await apiRequest(`/api/tasks/${task.id}/complete`, { method: "POST", cookie: repCookie, body: { note: "ok" } });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal((await apiRequest("/api/tasks/rewards", { cookie: repCookie })).data.rewards.length, 0);
  await apiRequest(`/api/tasks/${task.id}/reopen`, { method: "POST", cookie: repCookie, body: {} });
  await pool.query("UPDATE tasks SET status = 'done', completed_at = now() WHERE id = $1", [task.id]); // the system closes it this time
  assert.equal((await apiRequest("/api/tasks/rewards", { cookie: repCookie })).data.rewards.length, 1);
  await pool.query("UPDATE tasks SET reward_seen_at = now() WHERE id = $1", [task.id]);
});

test("old finished tasks (3+ days) and cancelled ones are not news; stats can be asked for without a reward", async () => {
  const old = await give();
  await pool.query("UPDATE tasks SET status = 'done', completed_at = now() - interval '4 days' WHERE id = $1", [old.id]);
  const cancelled = await give();
  await pool.query("UPDATE tasks SET status = 'cancelled' WHERE id = $1", [cancelled.id]);
  assert.equal((await apiRequest("/api/tasks/rewards", { cookie: repCookie })).data.rewards.length, 0);
  const asked = await apiRequest("/api/tasks/rewards?stats=1", { cookie: repCookie });
  assert.equal(asked.data.rewards.length, 0);
  assert.ok(asked.data.stats && asked.data.stats.open_left >= 0);
});

test("bad ids are ignored, not an error", async () => {
  const res = await apiRequest("/api/tasks/rewards/seen", { method: "POST", cookie: repCookie, body: { ids: ["x", -1, 0, null] } });
  assert.equal(res.status, 200);
  assert.equal(res.data.marked, 0);
});
