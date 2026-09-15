// The real engage-then-lift round trip for server/src/routes/lockdown.js,
// kept in its own file and run in isolation (see package.json's separate
// "test:lockdown" step, chained after the main parallel suite) rather than
// alongside the rest of test/integration/.
//
// lockdown.js's gate is GLOBAL, shared-database state (app_settings, read
// by every request via server/src/middleware/lockdown.js) -- actually
// engaging it here would 423 every other concurrently-running test file's
// requests against this same database, since node --test runs test files
// in parallel by default. This is the one test that needs the real thing;
// everything else about lockdown (role gating, the unauthenticated GET)
// lives safely in adminSettingsAndLockdown.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";

test.before(startTestServer);
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("POST /api/lockdown/engage and /lift: engaging invalidates every session including the admin's own; lifting restores normal access", async () => {
  const freshAdmin = await createUser("admin");
  const freshCookie = await loginAs(freshAdmin.email);
  try {
    const before = await apiRequest("/api/me", { cookie: freshCookie });
    assert.equal(before.status, 200);

    const engaged = await apiRequest("/api/lockdown/engage", { method: "POST", cookie: freshCookie });
    assert.equal(engaged.status, 200);
    assert.equal(engaged.data.enabled, true);

    const stateWhileLocked = await apiRequest("/api/lockdown");
    assert.equal(stateWhileLocked.data.enabled, true);

    // While lockdown is on, lockdownGate itself blocks every route outside
    // its allow-list with 423 before auth even runs -- so the OLD session's
    // real invalidation (token_version bumped) can only be observed once
    // lockdown is lifted again below.
    const blockedWhileLocked = await apiRequest("/api/me", { cookie: freshCookie });
    assert.equal(blockedWhileLocked.status, 423);

    // /api/auth/login and /api/lockdown/lift are both on the gate's
    // always-allowed list specifically so the admin who engaged it can log
    // back in and lift it -- the real production recovery path.
    const reloginCookie = await loginAs(freshAdmin.email);
    const lifted = await apiRequest("/api/lockdown/lift", { method: "POST", cookie: reloginCookie });
    assert.equal(lifted.status, 200);
    assert.equal(lifted.data.enabled, false);

    const staleSession = await apiRequest("/api/me", { cookie: freshCookie });
    assert.equal(staleSession.status, 401, "engaging lockdown must bump token_version app-wide -- the OLD session stays invalid even after lockdown itself is lifted");

    const workingAgain = await apiRequest("/api/me", { cookie: reloginCookie });
    assert.equal(workingAgain.status, 200, "a fresh session must work normally again once lockdown is lifted");
  } finally {
    // Guarantee this always clears however the assertions above landed --
    // lockdown is process-wide shared state that must never leak into any
    // other test run against this database.
    const { setLockdown } = await import("../../src/settings.js");
    await setLockdown(false, null);
  }
});
