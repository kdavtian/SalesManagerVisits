// Routes Distribution: management maintains the region/subregion -> sales
// channel mapping in bulk (multi-select tree on the Route Plans page).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, loginAs, apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const REGION = "ITestRegion";
test.before(startTestServer);
test.after(async () => {
  await pool.query("DELETE FROM route_distribution WHERE region = $1", [REGION]);
  await cleanupAll();
  await stopTestServer();
});

test("bulk set / overwrite / clear, and who may do it", async () => {
  const director = await createUser("sales_director");
  const manager = await createUser("sales_manager");
  const dCookie = await loginAs(director.email);
  const mCookie = await loginAs(manager.email);

  const denied = await apiRequest("/api/route-distribution/bulk", { method: "PUT", cookie: mCookie, body: { items: [{ region: REGION, sales_channel: "CVO" }] } });
  assert.equal(denied.status, 403);

  const bad = await apiRequest("/api/route-distribution/bulk", { method: "PUT", cookie: dCookie, body: { items: [] } });
  assert.equal(bad.status, 400);

  const set = await apiRequest("/api/route-distribution/bulk", {
    method: "PUT",
    cookie: dCookie,
    body: { items: [{ region: REGION, sales_channel: "CVO" }, { region: REGION, subregion: "Sub1", sales_channel: "PCO" }] },
  });
  assert.equal(set.status, 200);
  const mine = (rows) => rows.filter((r) => r.region === REGION).map((r) => [r.subregion, r.sales_channel]);
  assert.deepEqual(mine(set.data), [[null, "CVO"], ["Sub1", "PCO"]]);

  // Overwrite one, clear the other.
  const next = await apiRequest("/api/route-distribution/bulk", {
    method: "PUT",
    cookie: dCookie,
    body: { items: [{ region: REGION, sales_channel: "OEM" }, { region: REGION, subregion: "Sub1", sales_channel: null }] },
  });
  assert.deepEqual(mine(next.data), [[null, "OEM"]]);

  // Any signed-in user can still look the mapping up (new-customer form).
  const lookup = await apiRequest(`/api/route-distribution/lookup?region=${REGION}&subregion=Sub1`, { cookie: mCookie });
  assert.equal(lookup.data.sales_channel, "OEM");
});
