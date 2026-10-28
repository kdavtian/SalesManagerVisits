// Pause / offboard a rep (server/src/routes/users.js, migration 135): the account is switched off but kept, customers and open tasks can be
// handed over region by region in the same step, and the person disappears from rep lists and leaderboards.
// Logins are kept to a handful (the login limiter is shared by the whole process, see usersRoles.test.js).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, TEST_PASSWORD } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let admin;
let rep;
let heir;
let adminCookie;
let repCookie;
let heirCookie;
const region = `Itest Region ${Date.now()}`;
const customers = {};

async function task(assigneeId, customerId = null, title = "Itest task") {
  const { rows } = await pool.query(
    "INSERT INTO tasks (title, creator_id, assignee_id, customer_id, due_date) VALUES ($1, $2, $3, $4, CURRENT_DATE) RETURNING id",
    [title, admin.id, assigneeId, customerId]
  );
  return rows[0].id;
}

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager", { name: "Itest Leaving Rep" });
  heir = await createUser("sales_manager", { name: "Itest Heir Rep" });
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  heirCookie = await loginAs(heir.email);
  customers.north1 = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id });
  customers.north2 = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id });
  customers.south = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id });
  customers.none = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id });
  await pool.query("UPDATE customers SET region = $2 WHERE id = ANY($1)", [[customers.north1.id, customers.north2.id], region]);
  await pool.query("UPDATE customers SET region = $2 WHERE id = $1", [customers.south.id, `${region} South`]);
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const status = (id, body, cookie = adminCookie) => apiRequest(`/api/users/${id}/status`, { method: "POST", body, cookie });

test("only an admin can read the checklist or switch an account off", async () => {
  assert.equal((await apiRequest(`/api/users/${rep.id}/offboarding`, { cookie: repCookie })).status, 403);
  assert.equal((await status(rep.id, { status: "paused" }, repCookie)).status, 403);
  assert.equal((await status(admin.id, { status: "paused" })).status, 400, "an admin can't switch themselves off");
  assert.equal((await status(rep.id, { status: "gone" })).status, 400);
  assert.equal((await status(99999999, { status: "paused" })).status, 404);
});

test("the checklist counts what the rep still holds, by region, and offers only active reps as heirs", async () => {
  await task(rep.id, customers.north1.id);
  await task(rep.id);
  const res = await apiRequest(`/api/users/${rep.id}/offboarding`, { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.customers_total, 4);
  const byRegion = Object.fromEntries(res.data.regions.map((r) => [r.region, r.n]));
  assert.equal(byRegion[region], 2);
  assert.equal(byRegion[`${region} South`], 1);
  assert.equal(byRegion[""], 1);
  assert.equal(res.data.open_tasks, 2);
  assert.ok(res.data.candidates.some((c) => c.id === heir.id));
  assert.ok(!res.data.candidates.some((c) => c.id === rep.id));
});

test("a receiver must be another active sales rep or director", async () => {
  const bad = await status(rep.id, { status: "offboarded", moves: [{ region, to_user_id: admin.id }] });
  assert.equal(bad.status, 400);
  const self = await status(rep.id, { status: "offboarded", moves: [{ region, to_user_id: rep.id }] });
  assert.equal(self.status, 400);
  const { rows } = await pool.query("SELECT status FROM users WHERE id = $1", [rep.id]);
  assert.equal(rows[0].status, "active", "nothing changed after the refusals");
});

test("offboarding: customers move region by region, tasks follow, sessions die, login is refused, lists drop the rep, history stays", async () => {
  const listBefore = await apiRequest("/api/users/plannable", { cookie: adminCookie });
  assert.equal(listBefore.status, 200);
  assert.ok(listBefore.data.some((u) => u.id === rep.id));

  const res = await status(rep.id, {
    status: "offboarded",
    note: "Left the company",
    moves: [{ region, to_user_id: heir.id }, { region: `${region} South`, to_user_id: heir.id }],
    tasks_to_user_id: heir.id,
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.moved_customers, 3);
  assert.equal(res.data.moved_tasks, 2);
  assert.equal(res.data.user.status, "offboarded");

  const { rows: mine } = await pool.query("SELECT id, assigned_manager_id FROM customers WHERE id = ANY($1) ORDER BY id", [Object.values(customers).map((c) => c.id)]);
  const owner = Object.fromEntries(mine.map((c) => [c.id, c.assigned_manager_id]));
  assert.equal(owner[customers.north1.id], heir.id);
  assert.equal(owner[customers.south.id], heir.id);
  assert.equal(owner[customers.none.id], rep.id, "a region that was not chosen stays where it is");
  const { rows: tasks } = await pool.query("SELECT count(*)::int AS n FROM tasks WHERE assignee_id = $1 AND status = 'open'", [rep.id]);
  assert.equal(tasks[0].n, 0);

  // the old session is dead, the password no longer opens the app
  assert.equal((await apiRequest("/api/me", { cookie: repCookie })).status, 401);
  const login = await apiRequest("/api/auth/login", { method: "POST", body: { email: rep.email, password: TEST_PASSWORD } });
  assert.equal(login.status, 403);
  assert.equal(login.data.code, "account_inactive");
  const wrong = await apiRequest("/api/auth/login", { method: "POST", body: { email: rep.email, password: "not-the-password" } });
  assert.equal(wrong.status, 401, "a wrong password still looks like any other wrong password");

  // hidden from the rep lists, kept in the Team list with its status
  const listAfter = await apiRequest("/api/users/plannable", { cookie: adminCookie });
  assert.ok(!listAfter.data.some((u) => u.id === rep.id));
  assert.ok(listAfter.data.some((u) => u.id === heir.id));
  const team = await apiRequest("/api/users", { cookie: adminCookie });
  const row = team.data.find((u) => u.id === rep.id);
  assert.equal(row.status, "offboarded");
  assert.equal(row.status_note, "Left the company");
  const assignees = await apiRequest("/api/tasks/assignees", { cookie: adminCookie });
  assert.ok(!assignees.data.some((u) => u.id === rep.id));
  const checklist = await apiRequest(`/api/users/${rep.id}/offboarding`, { cookie: adminCookie });
  assert.ok(!checklist.data.candidates.some((c) => c.id === rep.id));
  // the heir still works
  assert.equal((await apiRequest("/api/me", { cookie: heirCookie })).status, 200);
});

test("switching back on: the account works again with the same password, and a hand-over is refused in that call", async () => {
  const refused = await status(rep.id, { status: "active", moves: [{ region, to_user_id: heir.id }] });
  assert.equal(refused.status, 400);
  const res = await status(rep.id, { status: "active" });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.status, "active");
  assert.equal(res.data.user.status_note, null);
  const login = await apiRequest("/api/auth/login", { method: "POST", body: { email: rep.email, password: TEST_PASSWORD } });
  assert.equal(login.status, 200);
});

test("pausing keeps everything in place unless a hand-over is chosen", async () => {
  const res = await status(rep.id, { status: "paused", note: "On leave" });
  assert.equal(res.status, 200);
  assert.equal(res.data.moved_customers, 0);
  const { rows } = await pool.query("SELECT assigned_manager_id FROM customers WHERE id = $1", [customers.none.id]);
  assert.equal(rows[0].assigned_manager_id, rep.id);
  const login = await apiRequest("/api/auth/login", { method: "POST", body: { email: rep.email, password: TEST_PASSWORD } });
  assert.equal(login.status, 403);
  assert.match(login.data.error, /paused/);
});

// Owner, 2026-10-28 ("Sevo's account was locked"): the admin lifts the lock from the Team page instead of waiting 15 minutes.
test("account lockout: the Team list shows the lock, an admin unlocks it, a rep cannot", async () => {
  const user = await createUser("sales_manager");
  await pool.query("UPDATE users SET failed_login_attempts = 0, locked_until = now() + interval '15 minutes' WHERE id = $1", [user.id]);

  const list = await apiRequest("/api/users", { cookie: adminCookie });
  assert.equal(list.data.find((u) => u.id === user.id).login_locked, true);

  assert.equal((await apiRequest(`/api/users/${user.id}/unlock`, { method: "POST", cookie: await loginAs(heir.email), body: {} })).status, 403);

  const unlock = await apiRequest(`/api/users/${user.id}/unlock`, { method: "POST", cookie: adminCookie, body: {} });
  assert.equal(unlock.status, 200);
  const after = await apiRequest("/api/users", { cookie: adminCookie });
  assert.equal(after.data.find((u) => u.id === user.id).login_locked, false);
  const success = await apiRequest("/api/auth/login", { method: "POST", body: { email: user.email, password: TEST_PASSWORD } });
  assert.equal(success.status, 200, "signs in right after the unlock");

  // a new password set by the admin lifts the lock too
  await pool.query("UPDATE users SET locked_until = now() + interval '15 minutes' WHERE id = $1", [user.id]);
  assert.equal((await apiRequest(`/api/users/${user.id}/password`, { method: "PATCH", cookie: adminCookie, body: { password: "NewPass12345!" } })).status, 204);
  const { rows } = await pool.query("SELECT locked_until FROM users WHERE id = $1", [user.id]);
  assert.equal(rows[0].locked_until, null);
});
