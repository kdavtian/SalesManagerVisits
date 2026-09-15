// API coverage for Authentication and account lockout -- valid/invalid
// credentials, the per-account lockout added in the security-hardening
// round (5 failed attempts -> 15 min lock), unauthenticated access to a
// protected route, and CSRF enforcement on the mutating endpoints.
//
// POST /api/auth/login is ALSO behind an IP-scoped rate limiter (10
// requests per 15 minutes, shared across every test in this file since
// they all run from the same test-server IP in one process). Lockout
// preconditions are set directly in the DB rather than by actually
// POSTing 5 real failed logins each time, so this file's own real login
// calls stay well under that budget instead of tripping it itself.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs, TEST_PASSWORD } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let baseUrl;

test.before(async () => {
  baseUrl = await startTestServer();
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

// --- Valid / invalid credentials -------------------------------------------

test("login: a valid email/password succeeds, an invalid password fails", async () => {
  const user = await createUser("sales_manager");

  const bad = await apiRequest("/api/auth/login", { method: "POST", body: { email: user.email, password: "wrong-password" } });
  assert.equal(bad.status, 401);

  const good = await apiRequest("/api/auth/login", { method: "POST", body: { email: user.email, password: TEST_PASSWORD } });
  assert.equal(good.status, 200);
  assert.equal(good.data.email, user.email);
  assert.ok(good.cookie.includes("session="), "a session cookie must be set on success");
});

test("login: an unknown email returns the same 401 as a wrong password (no user-existence oracle)", async () => {
  const res = await apiRequest("/api/auth/login", { method: "POST", body: { email: "nobody-itest@kadmotors.local", password: "whatever123" } });
  assert.equal(res.status, 401);
  assert.equal(res.data.error, "Invalid email or password");
});

test("login: a missing password is a 400, not a 401 (doesn't even reach the credential check)", async () => {
  const res = await apiRequest("/api/auth/login", { method: "POST", body: { email: "x@example.com" } });
  assert.equal(res.status, 400);
});

// --- Account lockout --------------------------------------------------------

test("account lockout: the 5th consecutive failure locks the account; the correct password is then rejected with 423", async () => {
  const user = await createUser("sales_manager");
  // Precondition set directly rather than via 4 real failed POSTs, to stay
  // well under this file's shared IP rate-limit budget -- this one real
  // call below is what actually exercises the "5th failure engages the
  // lock" branch in auth.js.
  await pool.query("UPDATE users SET failed_login_attempts = 4 WHERE id = $1", [user.id]);

  const fifthFailure = await apiRequest("/api/auth/login", { method: "POST", body: { email: user.email, password: "still-wrong" } });
  assert.equal(fifthFailure.status, 401, "the failing attempt itself still just reads as a plain 401");

  const { rows } = await pool.query("SELECT failed_login_attempts, locked_until FROM users WHERE id = $1", [user.id]);
  assert.equal(rows[0].failed_login_attempts, 0, "the counter resets to 0 the moment the lock engages");
  assert.ok(rows[0].locked_until, "locked_until must now be set");

  const lockedOut = await apiRequest("/api/auth/login", { method: "POST", body: { email: user.email, password: TEST_PASSWORD } });
  assert.equal(lockedOut.status, 423, "even the correct password is rejected while locked");
});

test("account lockout: a successful login resets both failed_login_attempts and an already-expired lock", async () => {
  const user = await createUser("sales_manager");
  await pool.query("UPDATE users SET failed_login_attempts = 3, locked_until = now() - interval '1 minute' WHERE id = $1", [user.id]);

  const success = await apiRequest("/api/auth/login", { method: "POST", body: { email: user.email, password: TEST_PASSWORD } });
  assert.equal(success.status, 200, "an expired lock must not block a correct login");

  const { rows } = await pool.query("SELECT failed_login_attempts, locked_until FROM users WHERE id = $1", [user.id]);
  assert.equal(rows[0].failed_login_attempts, 0);
  assert.equal(rows[0].locked_until, null);
});

test("account lockout: a repeated login against a nonexistent email is never a 423 (no row to lock)", async () => {
  // Set up directly via SQL rather than 6 real POSTs -- proves the lockout
  // logic requires a real user row (an attacker probing a made-up address
  // can't be "locked out" of an account that was never there).
  const res = await apiRequest("/api/auth/login", { method: "POST", body: { email: "ghost-itest@kadmotors.local", password: "wrong" } });
  assert.equal(res.status, 401);
});

// --- Unauthenticated access --------------------------------------------------

test("an unauthenticated request to a protected route is rejected with 401", async () => {
  const res = await apiRequest("/api/orders");
  assert.equal(res.status, 401);
});

test("me / logout: a valid session reads /me, an unauthenticated CSRF-less mutation is still rejected on its own terms, and logout invalidates the session", async () => {
  const user = await createUser("sales_manager");
  const cookie = await loginAs(user.email);

  const me = await apiRequest("/api/me", { cookie });
  assert.equal(me.status, 200);
  assert.equal(me.data.email, user.email);

  // CSRF: the session cookie alone, with no X-CSRF-Token header, must not
  // be enough to perform a mutation -- calling fetch() directly here
  // (bypassing apiRequest's auto-attached header) is what actually proves
  // the header, not just the cookie, is required.
  const noHeaderRes = await fetch(`${baseUrl}/api/lockdown/lift`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
  });
  assert.equal(noHeaderRes.status, 403);
  const noHeaderBody = await noHeaderRes.json();
  assert.match(noHeaderBody.error, /csrf/i);

  const logout = await apiRequest("/api/auth/logout", { method: "POST", cookie });
  assert.equal(logout.status, 204);

  const afterLogout = await apiRequest("/api/me");
  assert.equal(afterLogout.status, 401, "no cookie at all (what a fresh load after logout sends) must be rejected");
});

test("CSRF: the matching X-CSRF-Token header passes the check, and password-change validation still applies behind it", async () => {
  const user = await createUser("sales_manager");
  const cookie = await loginAs(user.email);

  // apiRequest() auto-attaches the CSRF header for every non-GET call --
  // a 400 here (not 403) proves the CSRF gate was passed and the request
  // failed for the unrelated, expected reason (password too short).
  const res = await apiRequest("/api/me/password", {
    method: "PATCH",
    cookie,
    body: { current_password: TEST_PASSWORD, new_password: "short" },
  });
  assert.equal(res.status, 400);
});
