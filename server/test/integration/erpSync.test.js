// API coverage for ERP synchronization (server/src/routes/erpSync.js):
// missing/wrong X-Sync-Key (a "missing external service"/auth case -- the
// route rejects everything when ERP_SYNC_KEY isn't configured at all,
// which is this app's actual production default per app.js's startup log),
// a valid sync end-to-end, malformed payload shape, and the
// TRUNCATE-and-replace semantics for erp_customer_data.
//
// ERP_SYNC_KEY must be set BEFORE app.js is imported (helpers.js ->
// app.js reads it at request time via process.env, but the route logs a
// permanent "sync endpoint disabled" warning at import time if it's unset
// -- see app.js's own startup check) -- set here, first, in this file's
// own process.
process.env.ERP_SYNC_KEY = "itest-sync-key";

import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createCustomer, createUser, apiRequest, apiFormRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

// POST /api/erp-sync unconditionally TRUNCATEs erp_customer_data on every
// successful call (see erpSync.js's "whole table replaced on every sync"
// comment) -- real behavior this file deliberately exercises below. But
// this test suite is also run by deploy/deploy.sh directly against the
// production database (there is no separate disposable test database in
// that environment), so without this snapshot/restore, every deploy that
// reaches this file would silently wipe real ERP debt/aging data down to
// just this file's fake test rows, restored only whenever the next real
// sync from the Windows PC pipeline happens to run. Snapshotting the whole
// table before and restoring it in test.after (which node:test still runs
// even if a test above throws) closes that window back down to the
// duration of this file's own run instead of leaving it open indefinitely.
let erpCustomerDataSnapshot;

test.before(async () => {
  await startTestServer();
  erpCustomerDataSnapshot = (await pool.query("SELECT * FROM erp_customer_data")).rows;
});
test.after(async () => {
  await cleanupAll();
  await pool.query("TRUNCATE erp_customer_data");
  if (erpCustomerDataSnapshot.length) {
    for (const row of erpCustomerDataSnapshot) {
      await pool.query(
        `INSERT INTO erp_customer_data
           (erp_customer_id, assigned_sales_rep, debt_amd, last_payment_date, days_since_payment, aging_bucket, recent_orders, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.erp_customer_id,
          row.assigned_sales_rep,
          row.debt_amd,
          row.last_payment_date,
          row.days_since_payment,
          row.aging_bucket,
          JSON.stringify(row.recent_orders),
          row.synced_at,
        ]
      );
    }
  }
  await stopTestServer();
});

const SYNC_KEY = "itest-sync-key";

async function syncRequest(body, headers = {}) {
  return apiRequest("/api/erp-sync", { method: "POST", body, headers });
}

// --- Missing / wrong sync key (missing external service / auth) --------------------

test("POST /api/erp-sync: no X-Sync-Key header is a 401", async () => {
  const res = await syncRequest({ customers: [] });
  assert.equal(res.status, 401);
});

test("POST /api/erp-sync: a wrong X-Sync-Key is a 401", async () => {
  const res = await syncRequest({ customers: [] }, { "X-Sync-Key": "wrong-key" });
  assert.equal(res.status, 401);
});

// --- Malformed payload ---------------------------------------------------------------

test("POST /api/erp-sync: customers must be an array", async () => {
  const res = await syncRequest({ customers: "not-an-array" }, { "X-Sync-Key": SYNC_KEY });
  assert.equal(res.status, 400);
});

test("POST /api/erp-sync: order_lines, if present, must be an array", async () => {
  const res = await syncRequest({ customers: [], order_lines: "nope" }, { "X-Sync-Key": SYNC_KEY });
  assert.equal(res.status, 400);
});

// --- Valid sync end-to-end + TRUNCATE-and-replace semantics -------------------------

test("POST /api/erp-sync: a valid payload syncs customers and reports counts", async () => {
  const manager = await createUser("sales_manager");
  const customer = await createCustomer({ created_by: manager.id, erp_customer_id: `ITEST-ERPSYNC-${Date.now()}` });

  const res = await syncRequest(
    {
      customers: [
        { erp_customer_id: customer.erp_customer_id, customer_name: customer.name, debt_amd: 15000, assigned_sales_rep: "Some Rep" },
      ],
    },
    { "X-Sync-Key": SYNC_KEY }
  );
  assert.equal(res.status, 200);
  assert.equal(res.data.synced, 1);

  const { rows } = await pool.query("SELECT debt_amd FROM erp_customer_data WHERE erp_customer_id = $1", [customer.erp_customer_id]);
  assert.equal(Number(rows[0].debt_amd), 15000);
});

test("POST /api/erp-sync: TRUNCATE-and-replace -- a customer absent from the new payload no longer appears", async () => {
  const manager = await createUser("sales_manager");
  const staleId = `ITEST-STALE-${Date.now()}`;
  const keptCustomer = await createCustomer({ created_by: manager.id, erp_customer_id: `ITEST-KEPT-${Date.now()}` });

  // First sync seeds two ERP customers.
  const first = await syncRequest(
    {
      customers: [
        { erp_customer_id: staleId, customer_name: "Stale Co", debt_amd: 1000 },
        { erp_customer_id: keptCustomer.erp_customer_id, customer_name: keptCustomer.name, debt_amd: 2000 },
      ],
    },
    { "X-Sync-Key": SYNC_KEY }
  );
  assert.equal(first.status, 200);
  assert.equal(first.data.synced, 2);

  const { rows: beforeRows } = await pool.query("SELECT erp_customer_id FROM erp_customer_data WHERE erp_customer_id = $1", [staleId]);
  assert.equal(beforeRows.length, 1);

  // Second sync omits the stale one entirely (debt fully paid, dropped out
  // of the extract) -- the whole-table TRUNCATE must remove it, not merge.
  const second = await syncRequest(
    { customers: [{ erp_customer_id: keptCustomer.erp_customer_id, customer_name: keptCustomer.name, debt_amd: 2500 }] },
    { "X-Sync-Key": SYNC_KEY }
  );
  assert.equal(second.status, 200);
  assert.equal(second.data.synced, 1);

  const { rows: afterRows } = await pool.query("SELECT erp_customer_id FROM erp_customer_data WHERE erp_customer_id = $1", [staleId]);
  assert.equal(afterRows.length, 0, "a customer dropped from the extract must not survive the sync");
});

// --- Combined sync notification (item 4: "I receive 4 notifications, want 1") ----

test("POST /api/erp-sync/daily-report and /reports: two calls in quick succession land as ONE combined notification, not two", async () => {
  const admin = await createUser("admin");
  const cookie = await loginAs(admin.email);

  const dailyReport = await apiRequest("/api/erp-sync/daily-report", {
    method: "POST",
    body: { report_date: "2026-09-23", sales: {}, payments: {}, balance: {} },
    headers: { "X-Sync-Key": SYNC_KEY },
  });
  assert.equal(dailyReport.status, 200);

  const form = new FormData();
  form.append("report_type", "sales_director");
  form.append("report_date", "2026-09-23");
  form.append("file", new Blob([Buffer.from("PK\x03\x04")], { type: "application/octet-stream" }), "report.xlsx");
  const reportUpload = await apiFormRequest("/api/erp-sync/reports", { form, headers: { "X-Sync-Key": SYNC_KEY } });
  assert.equal(reportUpload.status, 200);

  // The debounce window is shortened to 50ms in tests (NODE_ENV === "test",
  // see erpSync.js) -- wait past it before checking what actually got sent.
  await new Promise((resolve) => setTimeout(resolve, 250));

  const notifications = await apiRequest("/api/notifications", { cookie });
  assert.equal(notifications.status, 200);
  const combined = notifications.data.filter((n) => n.type === "sync_reports_ready");
  assert.equal(combined.length, 1, "two erp-sync calls close together must produce exactly one notification, not one per call");
  assert.match(combined[0].body, /Օրական հաշվետվություն/);
  assert.match(combined[0].body, /Sales Director/);
});
