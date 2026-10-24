// Excel sync status + the admin's "Sync now" (owner, 2026-10-24): GET /api/erp-sync/status, POST /api/erp-sync/request, and the bot's side
// (GET /requests/pending, POST /requests/:id/result with the sync key). Does not call POST /api/erp-sync itself (that truncates erp_customer_data,
// see erpSync.test.js); the run row is written through recordSyncRun, and everything this file creates is removed again (deploy.sh runs the
// tests against the production database).
process.env.ERP_SYNC_KEY = "itest-sync-key";
process.env.E2E_RATE_LIMIT_BYPASS_TOKEN = "itest-bypass";
const KEY = { "X-Sync-Key": "itest-sync-key", "x-e2e-rate-limit-bypass": "itest-bypass" };

import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { recordSyncRun } from "../../src/erpSyncStatus.js";

const FILE = `itest-status-${process.pid}.xlsx`;
let admin;
let rep;
let adminCookie;
let repCookie;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
});
test.after(async () => {
  await pool.query("DELETE FROM erp_sync_runs WHERE workbook_name = $1", [FILE]);
  await pool.query("DELETE FROM erp_sync_requests WHERE requested_by = ANY($1)", [[admin?.id, rep?.id].filter(Boolean)]);
  await cleanupAll();
  await stopTestServer();
});

test("status and request are for management only", async () => {
  assert.equal((await apiRequest("/api/erp-sync/status", { cookie: repCookie })).status, 403);
  assert.equal((await apiRequest("/api/erp-sync/request", { method: "POST", cookie: repCookie })).status, 403);
  assert.equal((await apiRequest("/api/erp-sync/status")).status, 401);
});

test("the last successful run shows the date of the Excel file and how old it is", async () => {
  const fileDate = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
  await recordSyncRun({ counts: { customers: 231 }, warnings: ["x: skipped"], meta: { workbook_modified_at: fileDate, workbook_name: FILE } });
  const { status, data } = await apiRequest("/api/erp-sync/status", { cookie: adminCookie });
  assert.equal(status, 200);
  assert.equal(data.last_success.workbook_name, FILE);
  assert.equal(data.last_success.counts.customers, 231);
  assert.ok(data.workbook_age_hours > 95 && data.workbook_age_hours < 97, `file age ${data.workbook_age_hours}`);
  assert.equal(data.workbook_stale, true, "a file older than the stale limit is flagged");
  assert.equal(data.sync_stale, false, "the sync itself just ran");
});

test("a run without meta (older bot) still records and shows no file date", async () => {
  await recordSyncRun({ counts: {}, meta: null });
  const { rows } = await pool.query("SELECT workbook_modified_at FROM erp_sync_runs ORDER BY id DESC LIMIT 1");
  assert.equal(rows[0].workbook_modified_at, null);
  await pool.query("DELETE FROM erp_sync_runs WHERE id = (SELECT MAX(id) FROM erp_sync_runs) AND workbook_name IS NULL AND workbook_modified_at IS NULL");
});

test("Sync now: one open request, the bot picks it up once and reports the result", async () => {
  const first = await apiRequest("/api/erp-sync/request", { method: "POST", cookie: adminCookie });
  assert.equal(first.status, 202);
  const again = await apiRequest("/api/erp-sync/request", { method: "POST", cookie: adminCookie });
  assert.equal(again.data.id, first.data.id, "a second tap while one waits returns the same request");
  assert.equal(again.data.existing, true);

  assert.equal((await apiRequest("/api/erp-sync/requests/pending", { headers: { "X-Sync-Key": "wrong" } })).status, 401);
  const pick = await apiRequest("/api/erp-sync/requests/pending", { headers: KEY });
  assert.equal(pick.data.request_id, first.data.id);
  const second = await apiRequest("/api/erp-sync/requests/pending", { headers: KEY });
  assert.equal(second.data.request_id, null, "picked up once");

  let st = (await apiRequest("/api/erp-sync/status", { cookie: adminCookie })).data;
  assert.equal(st.request.id, first.data.id);
  assert.equal(st.request.open, true);
  assert.ok(st.request.picked_at);

  const done = await apiRequest(`/api/erp-sync/requests/${first.data.id}/result`, { method: "POST", headers: KEY, body: { ok: true, message: "pushed 231 customers" } });
  assert.equal(done.data.finished, true);
  const twice = await apiRequest(`/api/erp-sync/requests/${first.data.id}/result`, { method: "POST", headers: KEY, body: { ok: false, message: "late" } });
  assert.equal(twice.data.finished, false, "a finished request is not overwritten");
  st = (await apiRequest("/api/erp-sync/status", { cookie: adminCookie })).data;
  assert.equal(st.request.ok, true);
  assert.equal(st.request.message, "pushed 231 customers");
  assert.equal(st.request.open, false);
});

test("a failed Sync now becomes a failed attempt for the admins", async () => {
  const { data } = await apiRequest("/api/erp-sync/request", { method: "POST", cookie: adminCookie });
  await apiRequest("/api/erp-sync/requests/pending", { headers: KEY });
  await apiRequest(`/api/erp-sync/requests/${data.id}/result`, { method: "POST", headers: KEY, body: { ok: false, message: `itest-boom-${process.pid}` } });
  const attempts = (await apiRequest("/api/erp-sync/attempts", { cookie: adminCookie })).data;
  assert.ok(attempts.some((a) => a.error === `itest-boom-${process.pid}` && a.ok === false));
  await pool.query("DELETE FROM erp_sync_attempts WHERE error = $1", [`itest-boom-${process.pid}`]);
});
