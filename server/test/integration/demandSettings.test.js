// The demand model's lead time and service level are admin settings (owner, 2026-11-03).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, loginAs, apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { getDemandSettings, setDemandSettings, zForServiceLevel } from "../../src/products/demandSettings.js";

test.before(startTestServer);
test.after(async () => {
  await setDemandSettings({ leadTimeDays: 45, serviceLevelPct: 95 });
  await cleanupAll();
  await stopTestServer();
});

test("z for a service level: the usual values, 95 % is the model's 1.65", () => {
  assert.equal(zForServiceLevel(95), 1.65);
  assert.equal(zForServiceLevel(90), 1.28);
  assert.equal(zForServiceLevel(99), 2.33);
  assert.ok(zForServiceLevel(85) > 1 && zForServiceLevel(85) < 1.1);
  assert.ok(zForServiceLevel(50) >= 0);
});

test("the admin sets the lead time and the service level; others read them, cannot change them; bad values are refused", async () => {
  const admin = await createUser("admin");
  const rep = await createUser("sales_manager");
  const adminCookie = await loginAs(admin.email);
  const repCookie = await loginAs(rep.email);
  const first = await apiRequest("/api/settings", { cookie: repCookie });
  assert.equal(first.data.demand_lead_time_days, 45);
  assert.equal(first.data.demand_service_level_pct, 95);
  const saved = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { demand_lead_time_days: 60, demand_service_level_pct: 90 } });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.demand_lead_time_days, 60);
  assert.deepEqual(await getDemandSettings(pool), { leadTimeDays: 60, serviceLevelPct: 90, serviceZ: 1.28 });
  assert.equal((await apiRequest("/api/settings", { cookie: repCookie })).data.demand_lead_time_days, 60);
  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: repCookie, body: { demand_lead_time_days: 10 } })).status, 403);
  for (const body of [{ demand_lead_time_days: 0 }, { demand_lead_time_days: 400 }, { demand_lead_time_days: 12.5 }, { demand_service_level_pct: 49 }, { demand_service_level_pct: 100 }]) {
    assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body })).status, 400, JSON.stringify(body));
  }
  // one value alone leaves the other as it was
  await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { demand_lead_time_days: 30 } });
  assert.deepEqual(await getDemandSettings(pool), { leadTimeDays: 30, serviceLevelPct: 90, serviceZ: 1.28 });
});
