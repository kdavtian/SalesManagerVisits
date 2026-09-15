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
import { startTestServer, stopTestServer, cleanupAll, createCustomer, createUser, apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

test.before(startTestServer);
test.after(async () => {
  await cleanupAll();
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
