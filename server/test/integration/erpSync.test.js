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
// Lets this file make more than the sync limiter's 20 calls (see syncKeyLimiter's skip).
process.env.E2E_RATE_LIMIT_BYPASS_TOKEN = "itest-bypass";
const BYPASS = { "x-e2e-rate-limit-bypass": "itest-bypass" };

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
  const res = await syncRequest({ customers: "not-an-array" }, { "X-Sync-Key": SYNC_KEY, ...BYPASS });
  assert.equal(res.status, 400);
});

test("POST /api/erp-sync: order_lines, if present, must be an array", async () => {
  const res = await syncRequest({ customers: [], order_lines: "nope" }, { "X-Sync-Key": SYNC_KEY, ...BYPASS });
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
    { "X-Sync-Key": SYNC_KEY, ...BYPASS }
  );
  assert.equal(res.status, 200);
  assert.equal(res.data.synced, 1);

  const { rows } = await pool.query("SELECT debt_amd FROM erp_customer_data WHERE erp_customer_id = $1", [customer.erp_customer_id]);
  assert.equal(Number(rows[0].debt_amd), 15000);
});

test("POST /api/erp-sync: customer tier follows the workbook Tier column (competitors untouched, blanks ignored)", async () => {
  const manager = await createUser("sales_manager");
  const stamp = Date.now();
  const a = await createCustomer({ created_by: manager.id, erp_customer_id: `ITEST-TIER-A-${stamp}` });
  const b = await createCustomer({ created_by: manager.id, erp_customer_id: `ITEST-TIER-B-${stamp}` });
  const c = await createCustomer({ created_by: manager.id, erp_customer_id: `ITEST-TIER-C-${stamp}` });
  await pool.query("UPDATE customers SET customer_tier = 'bronze' WHERE id = $1", [a.id]);
  await pool.query("UPDATE customers SET customer_tier = 'competitor' WHERE id = $1", [b.id]);
  await pool.query("UPDATE customers SET customer_tier = 'silver' WHERE id = $1", [c.id]);
  const res = await syncRequest(
    {
      customers: [
        { erp_customer_id: a.erp_customer_id, customer_name: a.name, erp_tier: "Gold" },
        { erp_customer_id: b.erp_customer_id, customer_name: b.name, erp_tier: "gold" },
        { erp_customer_id: c.erp_customer_id, customer_name: c.name, erp_tier: "" },
      ],
    },
    { "X-Sync-Key": SYNC_KEY, ...BYPASS }
  );
  assert.equal(res.status, 200);
  const tierOf = async (id) => (await pool.query("SELECT customer_tier FROM customers WHERE id = $1", [id])).rows[0].customer_tier;
  assert.equal(await tierOf(a.id), "gold");
  assert.equal(await tierOf(b.id), "competitor");
  assert.equal(await tierOf(c.id), "silver");
  const audit = await pool.query("SELECT old_tier, new_tier FROM customer_level_audit WHERE customer_id = $1", [a.id]);
  assert.deepEqual(audit.rows, [{ old_tier: "bronze", new_tier: "gold" }]);
});

test("POST /api/erp-sync: TIN, legal name and legal address are filled from the workbook only where empty", async () => {
  const manager = await createUser("sales_manager");
  const stamp = Date.now();
  const a = await createCustomer({ created_by: manager.id, erp_customer_id: `ITEST-LEG-A-${stamp}` });
  const b = await createCustomer({ created_by: manager.id, erp_customer_id: `ITEST-LEG-B-${stamp}` });
  await pool.query("UPDATE customers SET tin = '11111111', legal_name = 'Typed LLC', legal_address = 'Typed St 1' WHERE id = $1", [b.id]);
  const res = await syncRequest(
    {
      customers: [
        { erp_customer_id: a.erp_customer_id, customer_name: a.name, tin: 22222222, legal_name: "  Excel LLC ", legal_address: " Excel St 5 " },
        { erp_customer_id: b.erp_customer_id, customer_name: b.name, tin: "33333333", legal_name: "Other LLC", legal_address: "Other St 9" },
      ],
    },
    { "X-Sync-Key": SYNC_KEY, ...BYPASS }
  );
  assert.equal(res.status, 200);
  const rowOf = async (id) => (await pool.query("SELECT tin, legal_name, legal_address FROM customers WHERE id = $1", [id])).rows[0];
  assert.deepEqual(await rowOf(a.id), { tin: "22222222", legal_name: "Excel LLC", legal_address: "Excel St 5" });
  assert.deepEqual(await rowOf(b.id), { tin: "11111111", legal_name: "Typed LLC", legal_address: "Typed St 1" });
});

// Regression: a pre-existing, never-synced product whose stored
// name/brand/unit had drifted whitespace ("Orlen   5w40", a double space)
// used to fail the claim-by-identity match against an incoming sync row
// with normal spacing, inserting a brand-new row instead of linking to the
// one that's already there -- reported live as the same product listed
// twice with two different stock counts (e.g. "Orlen 5w40 4.5L" at both
// 32 and 33 units).
test("POST /api/erp-sync: a pre-existing product with whitespace-drifted name is claimed, not duplicated", async () => {
  const erpId = `ITEST-CLAIM-${Date.now()}`;
  const { rows: created } = await pool.query(
    "INSERT INTO products (name, brand, unit, unit_price_amd, active) VALUES ($1, $2, $3, 1000, true) RETURNING id",
    ["Orlen   5w40", "Orlen", "4.5L"]
  );
  const productId = created[0].id;
  try {
    const res = await syncRequest(
      { customers: [], products: [{ erp_product_id: erpId, name: "Orlen 5w40", brand: "Orlen", unit: "4.5 L", unit_price_amd: 25000, stock_qty: 33 }] },
      { "X-Sync-Key": SYNC_KEY, ...BYPASS }
    );
    assert.equal(res.status, 200);

    const { rows: matches } = await pool.query("SELECT id, stock_qty FROM products WHERE erp_product_id = $1", [erpId]);
    assert.equal(matches.length, 1, "exactly one product should carry this erp_product_id -- no duplicate inserted");
    assert.equal(matches[0].id, productId, "the pre-existing row must have been claimed, not left orphaned with a new row inserted alongside it");
    assert.equal(Number(matches[0].stock_qty), 33);
  } finally {
    await pool.query("DELETE FROM products WHERE id = $1 OR erp_product_id = $2", [productId, erpId]);
  }
});

// net_cost_amd has no current source column in the extract (see
// docs/erp-sync-contract.md), but the sync accepts it when sent, the same
// gated way as every other admin-editable field -- and critically must
// never clobber an existing value to null just because a later sync omits
// the field, unlike name/brand/price which the extract always sends.
test("POST /api/erp-sync: net_cost_amd syncs when sent, and is never cleared by a later sync that omits it", async () => {
  const erpId = `ITEST-NETCOST-${Date.now()}`;
  try {
    let res = await syncRequest(
      { customers: [], products: [{ erp_product_id: erpId, name: "Net Cost Test Oil", unit_price_amd: 10000, net_cost_amd: 7700 }] },
      { "X-Sync-Key": SYNC_KEY, ...BYPASS }
    );
    assert.equal(res.status, 200);
    let row = (await pool.query("SELECT net_cost_amd FROM products WHERE erp_product_id = $1", [erpId])).rows[0];
    assert.equal(Number(row.net_cost_amd), 7700);

    res = await syncRequest(
      { customers: [], products: [{ erp_product_id: erpId, name: "Net Cost Test Oil", unit_price_amd: 10500 }] },
      { "X-Sync-Key": SYNC_KEY, ...BYPASS }
    );
    assert.equal(res.status, 200);
    row = (await pool.query("SELECT net_cost_amd, unit_price_amd FROM products WHERE erp_product_id = $1", [erpId])).rows[0];
    assert.equal(Number(row.net_cost_amd), 7700, "omitting net_cost_amd on a later sync must not clear the existing value");
    assert.equal(Number(row.unit_price_amd), 10500, "other fields still update normally");
  } finally {
    await pool.query("DELETE FROM products WHERE erp_product_id = $1", [erpId]);
  }
});

// HC (ՀԾ-Հաշվապահ) product code from the workbook's Products sheet: applied
// when present (even on a manually edited product), kept as text with its
// leading zeros, and never wiped by a later sync where the sheet cell is blank.
test("POST /api/erp-sync: tier prices and net cost refresh even for a manually edited product", async () => {
  const erpId = `ITEST-PRICES-${Date.now()}`;
  try {
    await syncRequest({ customers: [], products: [{ erp_product_id: erpId, name: "Manual Price Oil", unit_price_amd: 9000, bronze_price_amd: 9000, silver_price_amd: 8000 }] }, { "X-Sync-Key": SYNC_KEY, ...BYPASS });
    await pool.query("UPDATE products SET manually_edited_at = now(), name = 'Renamed By Hand' WHERE erp_product_id = $1", [erpId]);
    const res = await syncRequest(
      { customers: [], products: [{ erp_product_id: erpId, name: "Manual Price Oil", unit_price_amd: 9700, bronze_price_amd: 9700, silver_price_amd: 8700, gold_price_amd: 6000, net_cost_amd: 5315 }] },
      { "X-Sync-Key": SYNC_KEY, ...BYPASS }
    );
    assert.equal(res.status, 200);
    const row = (await pool.query("SELECT name, bronze_price_amd, silver_price_amd, gold_price_amd, net_cost_amd FROM products WHERE erp_product_id = $1", [erpId])).rows[0];
    assert.equal(row.name, "Renamed By Hand", "name stays gated by manually_edited_at");
    assert.deepEqual([row.bronze_price_amd, row.silver_price_amd, row.gold_price_amd, row.net_cost_amd].map(Number), [9700, 8700, 6000, 5315]);
  } finally {
    await pool.query("DELETE FROM products WHERE erp_product_id = $1", [erpId]);
  }
});

test("POST /api/erp-sync: SKU status decides what is active, family follows the workbook, inactive products are not created", async () => {
  const stamp = Date.now();
  const keep = `ITEST-ACT-KEEP-${stamp}`;
  const drop = `ITEST-ACT-DROP-${stamp}`;
  const never = `ITEST-ACT-NEVER-${stamp}`;
  const ids = [keep, drop, never];
  try {
    await syncRequest({ customers: [], products: [
      { erp_product_id: keep, name: "Active Oil", unit_price_amd: 9000, family: "Old Family" },
      { erp_product_id: drop, name: "Soon Inactive Oil", unit_price_amd: 9000 },
    ] }, { "X-Sync-Key": SYNC_KEY, ...BYPASS });
    await pool.query("UPDATE products SET manually_edited_at = now() WHERE erp_product_id = $1", [keep]);
    const res = await syncRequest({ customers: [], products: [
      { erp_product_id: keep, name: "Active Oil", unit_price_amd: 9100, family: "Edge", active: true },
      { erp_product_id: drop, name: "Soon Inactive Oil", unit_price_amd: 9000, active: false },
      { erp_product_id: never, name: "Never Active Oil", unit_price_amd: 0, active: false },
    ] }, { "X-Sync-Key": SYNC_KEY, ...BYPASS });
    assert.equal(res.status, 200);
    const rows = Object.fromEntries((await pool.query("SELECT erp_product_id, active, family, unit_price_amd FROM products WHERE erp_product_id = ANY($1)", [ids])).rows.map((r) => [r.erp_product_id, r]));
    assert.equal(rows[keep].active, true);
    assert.equal(rows[keep].family, "Edge", "family from the workbook applies even to a manually edited product");
    assert.equal(Number(rows[keep].unit_price_amd), 9100);
    assert.equal(rows[drop].active, false);
    assert.equal(rows[never], undefined, "an inactive product the app never had is not created");
    // No status sent (older workbook) leaves active untouched.
    await syncRequest({ customers: [], products: [{ erp_product_id: drop, name: "Soon Inactive Oil", unit_price_amd: 9000 }] }, { "X-Sync-Key": SYNC_KEY, ...BYPASS });
    assert.equal((await pool.query("SELECT active FROM products WHERE erp_product_id = $1", [drop])).rows[0].active, false);
  } finally {
    await pool.query("DELETE FROM products WHERE erp_product_id = ANY($1)", [ids]);
  }
});

test("POST /api/erp-sync: hc_code syncs as text, applies to manually edited products, and a blank later value keeps it", async () => {
  const erpId = `ITEST-HC-${Date.now()}`;
  try {
    let res = await syncRequest({ customers: [], products: [{ erp_product_id: erpId, name: "HC Test Oil", unit_price_amd: 10000, hc_code: " 000010 " }] }, { "X-Sync-Key": SYNC_KEY, ...BYPASS });
    assert.equal(res.status, 200);
    let row = (await pool.query("SELECT hc_code FROM products WHERE erp_product_id = $1", [erpId])).rows[0];
    assert.equal(row.hc_code, "000010");

    await pool.query("UPDATE products SET manually_edited_at = now() WHERE erp_product_id = $1", [erpId]);
    res = await syncRequest({ customers: [], products: [{ erp_product_id: erpId, name: "HC Test Oil", unit_price_amd: 10000, hc_code: "00686-14" }] }, { "X-Sync-Key": SYNC_KEY, ...BYPASS });
    row = (await pool.query("SELECT hc_code FROM products WHERE erp_product_id = $1", [erpId])).rows[0];
    assert.equal(row.hc_code, "00686-14", "a manually edited product still gets its HC code from the sheet");

    res = await syncRequest({ customers: [], products: [{ erp_product_id: erpId, name: "HC Test Oil", unit_price_amd: 10000, hc_code: "" }] }, { "X-Sync-Key": SYNC_KEY, ...BYPASS });
    row = (await pool.query("SELECT hc_code FROM products WHERE erp_product_id = $1", [erpId])).rows[0];
    assert.equal(row.hc_code, "00686-14", "a blank sheet cell must not wipe the stored code");
  } finally {
    await pool.query("DELETE FROM products WHERE erp_product_id = $1", [erpId]);
  }
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
    { "X-Sync-Key": SYNC_KEY, ...BYPASS }
  );
  assert.equal(first.status, 200);
  assert.equal(first.data.synced, 2);

  const { rows: beforeRows } = await pool.query("SELECT erp_customer_id FROM erp_customer_data WHERE erp_customer_id = $1", [staleId]);
  assert.equal(beforeRows.length, 1);

  // Second sync omits the stale one entirely (debt fully paid, dropped out
  // of the extract) -- the whole-table TRUNCATE must remove it, not merge.
  const second = await syncRequest(
    { customers: [{ erp_customer_id: keptCustomer.erp_customer_id, customer_name: keptCustomer.name, debt_amd: 2500 }] },
    { "X-Sync-Key": SYNC_KEY, ...BYPASS }
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
    headers: { "X-Sync-Key": SYNC_KEY, ...BYPASS },
  });
  assert.equal(dailyReport.status, 200);

  const form = new FormData();
  form.append("report_type", "sales_director");
  form.append("report_date", "2026-09-23");
  form.append("file", new Blob([Buffer.from("PK\x03\x04")], { type: "application/octet-stream" }), "report.xlsx");
  const reportUpload = await apiFormRequest("/api/erp-sync/reports", { form, headers: { "X-Sync-Key": SYNC_KEY, ...BYPASS } });
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
