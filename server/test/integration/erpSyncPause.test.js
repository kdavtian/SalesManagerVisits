// Owner, 2026-11-07: admin can pause the Excel sync. While paused the bot's syncs are refused (423) and change nothing; turning it off lets
// the next sync through. Global switch: listed in isolated-tests.txt (it would refuse other files' syncs).
process.env.ERP_SYNC_KEY = "itest-sync-key";
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let adminCookie, repCookie, admin;
test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs((await createUser("sales_manager")).email);
});
test.after(async () => {
  await pool.query("UPDATE app_settings SET erp_sync_paused = false, erp_sync_paused_at = NULL, erp_sync_paused_by = NULL WHERE id = 1");
  await cleanupAll();
  await stopTestServer();
});

const sync = (body) => apiRequest("/api/erp-sync", { method: "POST", body, headers: { "X-Sync-Key": "itest-sync-key" } });

test("only admin / CEO pause the sync; while paused the bot's sync is refused and changes nothing; resume lets it through", async () => {
  assert.equal((await apiRequest("/api/erp-sync/pause", { method: "PUT", cookie: repCookie, body: { paused: true } })).status, 403);
  assert.equal((await apiRequest("/api/erp-sync/pause", { method: "PUT", cookie: adminCookie, body: { paused: "yes" } })).status, 400);
  const on = await apiRequest("/api/erp-sync/pause", { method: "PUT", cookie: adminCookie, body: { paused: true } });
  assert.equal(on.status, 200);
  assert.equal(on.data.paused, true);
  assert.equal(on.data.paused_by_name, admin.name);

  const erpId = `PAUSE${Date.now()}`;
  const customer = await createCustomer({ created_by: admin.id, erp_customer_id: erpId });
  const body = { customers: [{ customer_id: erpId, customer_name: "Paused Shop", debt_amd: 12345 }] };
  const refused = await sync(body);
  assert.equal(refused.status, 423);
  assert.equal(refused.data.code, "sync_paused");
  const ledger = await apiRequest("/api/erp-sync/cashflow-ledger", { method: "POST", body: { rows: [{ date: "2026-01-01", amount: 1 }] }, headers: { "X-Sync-Key": "itest-sync-key" } });
  assert.equal(ledger.status, 423);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM erp_customer_data WHERE erp_customer_id = $1", [erpId])).rows[0].n, 0);
  // a refused sync is not a failed one (no alarm)
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM erp_sync_attempts WHERE ok = false AND at > now() - interval '1 minute' AND error ILIKE '%paused%'")).rows[0].n, 0);
  const status = await apiRequest("/api/erp-sync/status", { cookie: adminCookie });
  assert.equal(status.data.pause.paused, true);
  assert.equal(status.data.can_pause, true);

  const off = await apiRequest("/api/erp-sync/pause", { method: "PUT", cookie: adminCookie, body: { paused: false } });
  assert.equal(off.data.paused, false);
  const ok = await sync(body);
  assert.notEqual(ok.status, 423, JSON.stringify(ok.data));
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [erpId]);
  void customer;
});
