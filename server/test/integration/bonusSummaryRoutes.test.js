// HTTP-level coverage for GET /api/bonus-summary: 404 while bonuses_enabled
// is off (not a bare empty summary -- the module shouldn't even look
// reachable), 200 with the caller's own data once enabled, and 401
// unauthenticated.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { setBonusesEnabled } from "../../src/bonusSettings.js";

let manager;
let cookie;

test.before(async () => {
  await startTestServer();
  manager = await createUser("sales_manager");
  cookie = await loginAs(manager.email);
});
test.after(async () => {
  await setBonusesEnabled(false);
  await pool.query("DELETE FROM bonus_point_ledger WHERE user_id = $1", [manager.id]);
  await cleanupAll();
  await stopTestServer();
});

test("GET /api/bonus-summary: 404 while disabled, 200 with the caller's own summary once enabled, 401 unauthenticated", async () => {
  await setBonusesEnabled(false);
  const disabled = await apiRequest("/api/bonus-summary", { cookie });
  assert.equal(disabled.status, 404);

  await setBonusesEnabled(true);
  const enabled = await apiRequest("/api/bonus-summary", { cookie });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.pointsTotal, 0);
  assert.deepEqual(enabled.data.activeChallenges, []);
  assert.deepEqual(enabled.data.claims, []);

  const unauthenticated = await apiRequest("/api/bonus-summary");
  assert.equal(unauthenticated.status, 401);
  await setBonusesEnabled(false);
});
