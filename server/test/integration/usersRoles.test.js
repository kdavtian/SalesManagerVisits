// API coverage for Users and roles (server/src/routes/users.js) -- admin-only
// management CRUD, its two narrower non-admin GETs, role validation, and
// the DB unique-email constraint surfacing as a clean 409.
//
// POST /api/auth/login is behind an IP-scoped rate limiter (10 requests per
// 15 minutes, shared across every test in this file since they all run from
// the same test-server IP in one process -- see auth.test.js for the same
// constraint). All fixture users are created and logged in exactly ONCE in
// test.before(), with the resulting session cookies cached and reused across
// every test below, keeping this file's real login-call count fixed at 9
// regardless of how many tests use a given role's cookie.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";

let admin;
let cookies; // role -> session cookie, one login per role

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  cookies = {};
  for (const role of ["admin", "sales_manager", "sales_director", "warehouse_manager", "delivery_manager", "accountant", "ceo", "operations_director"]) {
    const user = role === "admin" ? admin : await createUser(role);
    cookies[role] = await loginAs(user.email);
  }
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

// --- Valid requests + role enforcement --------------------------------------

test("GET /api/users: admin sees the full user list; every other role gets 403", async () => {
  const adminList = await apiRequest("/api/users", { cookie: cookies.admin });
  assert.equal(adminList.status, 200);
  assert.ok(Array.isArray(adminList.data));
  assert.ok(adminList.data.some((u) => u.id === admin.id));

  for (const role of ["sales_manager", "sales_director", "warehouse_manager", "delivery_manager", "accountant", "ceo", "operations_director"]) {
    const res = await apiRequest("/api/users", { cookie: cookies[role] });
    assert.equal(res.status, 403, role);
  }
});

test("POST /api/users: admin can create a user; every other role gets 403", async () => {
  const email = `itest-created-${Date.now()}@kadmotors.local`;

  const created = await apiRequest("/api/users", {
    method: "POST",
    cookie: cookies.admin,
    body: { email, password: "a-valid-password", name: "New Test User", role: "sales_manager" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.email, email);

  const forbidden = await apiRequest("/api/users", {
    method: "POST",
    cookie: cookies.sales_manager,
    body: { email: "should-not-be-created@kadmotors.local", password: "a-valid-password", name: "X", role: "sales_manager" },
  });
  assert.equal(forbidden.status, 403);
});

test("GET /api/users/plannable: open to canPlanForOthers roles, 403 for a plain sales_manager", async () => {
  const allowed = await apiRequest("/api/users/plannable", { cookie: cookies.sales_director });
  assert.equal(allowed.status, 200);

  const denied = await apiRequest("/api/users/plannable", { cookie: cookies.sales_manager });
  assert.equal(denied.status, 403);
});

// --- Invalid / boundary input ------------------------------------------------

test("POST /api/users: missing required fields is a 400", async () => {
  const res = await apiRequest("/api/users", { method: "POST", cookie: cookies.admin, body: { email: "x@example.com" } });
  assert.equal(res.status, 400);
});

test("POST /api/users: an invalid role is a 400, not a silently-accepted row", async () => {
  const res = await apiRequest("/api/users", {
    method: "POST",
    cookie: cookies.admin,
    body: { email: `itest-badrole-${Date.now()}@kadmotors.local`, password: "a-valid-password", name: "X", role: "superuser" },
  });
  assert.equal(res.status, 400);
});

test("POST /api/users: a password under 8 characters is a 400 (boundary: 7 fails, 8 succeeds)", async () => {
  const tooShort = await apiRequest("/api/users", {
    method: "POST",
    cookie: cookies.admin,
    body: { email: `itest-short-${Date.now()}@kadmotors.local`, password: "1234567", name: "X", role: "sales_manager" },
  });
  assert.equal(tooShort.status, 400);

  const exactlyEight = await apiRequest("/api/users", {
    method: "POST",
    cookie: cookies.admin,
    body: { email: `itest-eight-${Date.now()}@kadmotors.local`, password: "12345678", name: "X", role: "sales_manager" },
  });
  assert.equal(exactlyEight.status, 201);
});

test("DELETE /api/users/:id: an admin cannot delete their own account", async () => {
  const res = await apiRequest(`/api/users/${admin.id}`, { method: "DELETE", cookie: cookies.admin });
  assert.equal(res.status, 400);
});

test("PATCH /api/users/:id/role: an admin can change another user's role; a sales_manager gets 403; an admin cannot change their own; an invalid role is a 400", async () => {
  const target = await createUser("sales_manager");

  const denied = await apiRequest(`/api/users/${target.id}/role`, { method: "PATCH", cookie: cookies.sales_manager, body: { role: "operations_director" } });
  assert.equal(denied.status, 403);

  const changed = await apiRequest(`/api/users/${target.id}/role`, { method: "PATCH", cookie: cookies.admin, body: { role: "operations_director" } });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.role, "operations_director");

  const self = await apiRequest(`/api/users/${admin.id}/role`, { method: "PATCH", cookie: cookies.admin, body: { role: "ceo" } });
  assert.equal(self.status, 400);

  const invalid = await apiRequest(`/api/users/${target.id}/role`, { method: "PATCH", cookie: cookies.admin, body: { role: "superuser" } });
  assert.equal(invalid.status, 400);
});

test("PATCH, DELETE /api/users/:id: a nonexistent id is a 404, not a silent success", async () => {
  const missingId = 999999999;

  const patchRes = await apiRequest(`/api/users/${missingId}`, { method: "PATCH", cookie: cookies.admin, body: { name: "Ghost" } });
  assert.equal(patchRes.status, 404);

  const roleRes = await apiRequest(`/api/users/${missingId}/role`, { method: "PATCH", cookie: cookies.admin, body: { role: "ceo" } });
  assert.equal(roleRes.status, 404);

  const deleteRes = await apiRequest(`/api/users/${missingId}`, { method: "DELETE", cookie: cookies.admin });
  assert.equal(deleteRes.status, 404);
});

// --- DB constraint failures ---------------------------------------------------

test("POST /api/users: a duplicate email is a clean 409, not a raw DB error", async () => {
  const existing = await createUser("sales_manager");

  const res = await apiRequest("/api/users", {
    method: "POST",
    cookie: cookies.admin,
    body: { email: existing.email, password: "a-valid-password", name: "Duplicate", role: "sales_manager" },
  });
  assert.equal(res.status, 409);
});

test("PATCH /api/users/:id: renaming a user's email to one already in use is also a clean 409", async () => {
  const userA = await createUser("sales_manager");
  const userB = await createUser("sales_manager");

  const res = await apiRequest(`/api/users/${userA.id}`, { method: "PATCH", cookie: cookies.admin, body: { email: userB.email } });
  assert.equal(res.status, 409);
});

// --- Unauthenticated ----------------------------------------------------------

test("every /api/users endpoint rejects an unauthenticated request with 401", async () => {
  const listRes = await apiRequest("/api/users");
  assert.equal(listRes.status, 401);
  const createRes = await apiRequest("/api/users", { method: "POST", body: { email: "x@example.com", password: "12345678", name: "X", role: "sales_manager" } });
  assert.equal(createRes.status, 401);
});

// --- Password reset (admin-driven) --------------------------------------------

test("PATCH /api/users/:id/password: an admin resetting a user's password bumps token_version (invalidating existing sessions)", async () => {
  // A dedicated user + its own real login: this is the one real login call
  // in this file that a shared cookies[] entry can't serve, since the test
  // itself invalidates the session it logs in with.
  const target = await createUser("sales_manager");
  const targetCookieBefore = await loginAs(target.email);

  const before = await apiRequest("/api/me", { cookie: targetCookieBefore });
  assert.equal(before.status, 200);

  const reset = await apiRequest(`/api/users/${target.id}/password`, { method: "PATCH", cookie: cookies.admin, body: { password: "a-new-password" } });
  assert.equal(reset.status, 204);

  const afterReset = await apiRequest("/api/me", { cookie: targetCookieBefore });
  assert.equal(afterReset.status, 401, "the old session cookie must be invalidated by the reset");
});
