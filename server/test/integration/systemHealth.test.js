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

// deploy/backup.sh writes one backup_runs row per night (migration 231); System health shows the last good one, red after 36 h.
test("system health: last good backup, stale after 36 hours, a newer failure is reported", async () => {
  const { pool } = await import("../../src/db/pool.js");
  const { isBackupStale, BACKUP_STALE_AFTER_HOURS } = await import("../../src/system/backupStatus.js");
  assert.equal(BACKUP_STALE_AFTER_HOURS, 36);
  const now = new Date("2026-11-28T12:00:00Z");
  assert.equal(isBackupStale(null, now), true, "never backed up = red");
  assert.equal(isBackupStale("2026-11-27T02:30:00Z", now), false, "last night's backup is fine");
  assert.equal(isBackupStale("2026-11-26T23:00:00Z", now), true, "37 h old = red");

  await pool.query("DELETE FROM backup_runs");
  try {
    let h = (await apiRequest("/api/system-health", { cookie: adminCookie })).data;
    assert.equal(h.backup.last_ok_at, null);
    assert.equal(h.backup.stale, true, "no backup at all is red");

    await pool.query(
      `INSERT INTO backup_runs (finished_at, ok, db_bytes, uploads_bytes, offsite, detail) VALUES
         (now() - interval '50 hours', true, 1000, 2000, 'telegram', NULL),
         (now() - interval '3 hours', true, 55774, 62914560, 'spaces,telegram', NULL)`
    );
    h = (await apiRequest("/api/system-health", { cookie: adminCookie })).data;
    assert.equal(h.backup.stale, false);
    assert.equal(h.backup.offsite, "spaces,telegram");
    assert.equal(Number(h.backup.db_bytes), 55774);
    assert.equal(h.backup.last_failed_at, null);

    await pool.query("INSERT INTO backup_runs (finished_at, ok, detail) VALUES (now() - interval '1 hour', false, 'off-server copy')");
    h = (await apiRequest("/api/system-health", { cookie: adminCookie })).data;
    assert.equal(h.backup.last_failed_step, "off-server copy", "a failure after the last good run is shown");
    assert.equal(h.backup.stale, false, "but the last good backup is still recent");

    await pool.query("UPDATE backup_runs SET finished_at = finished_at - interval '40 hours'");
    h = (await apiRequest("/api/system-health", { cookie: adminCookie })).data;
    assert.equal(h.backup.stale, true, "43 h since the last good backup = red");
  } finally {
    await pool.query("DELETE FROM backup_runs");
  }
});
