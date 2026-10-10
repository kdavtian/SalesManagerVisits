// Admin "System health": versions the server serves, migrations, ERP feed freshness, integrations.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";

let adminCookie, repCookie, ceoCookie;
test.before(async () => {
  await startTestServer();
  adminCookie = await loginAs((await createUser("admin")).email);
  repCookie = await loginAs((await createUser("sales_manager")).email);
  ceoCookie = await loginAs((await createUser("ceo")).email);
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

test("system health: admin only, reports the served version, migrations and feed freshness", async () => {
  assert.equal((await apiRequest("/api/system-health", { cookie: repCookie })).status, 403);
  assert.equal((await apiRequest("/api/system-health", { cookie: ceoCookie })).status, 403);
  assert.equal((await apiRequest("/api/system-health")).status, 401);

  const res = await apiRequest("/api/system-health", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const h = res.data;
  const versionFile = fs.readFileSync(path.join(process.cwd(), "..", "client", "public", "js", "version.js"), "utf8");
  assert.equal(h.server_version, versionFile.match(/APP_VERSION\s*=\s*"([^"]+)"/)[1]);
  assert.match(h.cache_version, /^field-visits-v\d+$/);
  assert.equal(h.database.ok, true);
  assert.deepEqual(h.migrations.pending, [], "all migrations applied");
  assert.match(h.migrations.latest, /^\d+_.+\.sql$/);
  assert.ok(h.erp.sources.length >= 5);
  assert.ok(h.erp.sources.every((s) => typeof s.stale === "boolean" && s.label));
  assert.equal(typeof h.integrations.push, "boolean");
  assert.ok(!JSON.stringify(h).match(/token|secret|password/i), "no secrets in the payload");
});
