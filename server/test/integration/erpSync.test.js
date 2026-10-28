// API coverage for ERP synchronization (server/src/erp/routes/erpSync.js):
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

test("POST /api/erp-sync: customer_legal fills TIN/legal info for customers outside the customers[] extract, without creating erp_customer_data rows", async () => {
  const manager = await createUser("sales_manager");
  const stamp = Date.now();
  const a = await createCustomer({ created_by: manager.id, erp_customer_id: `ITEST-CL-A-${stamp}` });
  const res = await syncRequest(
    {
      customers: [],
      customer_legal: [
        { erp_customer_id: a.erp_customer_id, tin: "44444444", legal_name: "Legal Only LLC", legal_address: "Addr 7" },
        { erp_customer_id: `ITEST-CL-MISSING-${stamp}`, tin: "55555555" },
        { erp_customer_id: a.erp_customer_id, tin: "bad" },
      ],
    },
    { "X-Sync-Key": SYNC_KEY, ...BYPASS }
  );
  assert.equal(res.status, 200);
  const row = (await pool.query("SELECT tin, legal_name, legal_address FROM customers WHERE id = $1", [a.id])).rows[0];
  assert.deepEqual(row, { tin: "44444444", legal_name: "Legal Only LLC", legal_address: "Addr 7" });
  const erp = await pool.query("SELECT 1 FROM erp_customer_data WHERE erp_customer_id = $1", [a.erp_customer_id]);
  assert.equal(erp.rowCount, 0);
  const bad = await syncRequest({ customers: [], customer_legal: "x" }, { "X-Sync-Key": SYNC_KEY, ...BYPASS });
  assert.equal(bad.status, 400);
});

test("POST /api/erp-sync: customer_legal restores the leading zeros Excel drops from a numeric TIN", async () => {
  const manager = await createUser("sales_manager");
  const a = await createCustomer({ created_by: manager.id, erp_customer_id: `ITEST-CL-Z-${Date.now()}` });
  const res = await syncRequest(
    { customers: [], customer_legal: [{ erp_customer_id: a.erp_customer_id, tin: 4108 }] },
    { "X-Sync-Key": SYNC_KEY, ...BYPASS }
  );
  assert.equal(res.status, 200);
  const row = (await pool.query("SELECT tin FROM customers WHERE id = $1", [a.id])).rows[0];
  assert.equal(row.tin, "00004108");
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
  process.env.SYNC_NOTICE_QUIET_MS = "700"; // a wide window: the two calls below are a few ms apart on a fast machine, 60+ ms on a loaded runner
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
  await new Promise((resolve) => setTimeout(resolve, 1200));
  delete process.env.SYNC_NOTICE_QUIET_MS;

  const notifications = await apiRequest("/api/notifications", { cookie });
  assert.equal(notifications.status, 200);
  const combined = notifications.data.filter((n) => n.type === "sync_reports_ready");
  assert.equal(combined.length, 1, "two erp-sync calls close together must produce exactly one notification, not one per call");
  assert.match(combined[0].body, /Օրական հաշվետվություն/);
  assert.match(combined[0].body, /Sales Director/);
});

// Landing cost calculated by the app from the pack data (owner, 2026-10-19) and Retail price from Excel.
// Settings are restored afterwards: this suite also runs against the production database on deploy.
test("POST /api/erp-sync: landing cost is calculated from the pack USD price; no pack data or an outlier keeps the workbook's value", async () => {
  const stamp = Date.now();
  const ids = { ok: `ITEST-LC-OK-${stamp}`, none: `ITEST-LC-NONE-${stamp}`, bad: `ITEST-LC-BAD-${stamp}` };
  const saved = (await pool.query("SELECT landing_calc_enabled, landing_usd_rate FROM app_settings WHERE id = 1")).rows[0];
  const admin = await createUser("admin");
  const cookie = await loginAs(admin.email);
  const send = (products) => syncRequest({ customers: [], products }, { "X-Sync-Key": SYNC_KEY, ...BYPASS });
  const landing = async (id) => (await pool.query("SELECT landing_cost_amd, landing_workbook_amd, landing_source FROM products WHERE erp_product_id = $1", [id])).rows[0];
  try {
    await apiRequest("/api/settings", { method: "PATCH", cookie, body: { landing_calc_enabled: true, landing_usd_rate: 366 } });
    // Edge 4L-like pack: 4 items of 1 L, 3.6 kg a pack, 24 USD a pack. The workbook (377.5) says 3,900 AMD per item.
    const pack = { brand: "Castrol", unit: "1L", unit_price_amd: 9000, pack_cost_usd: 24, items_per_pack: 4, pack_netto_kg: 3.6, size_l: 1 };
    const res = await send([
      { ...pack, erp_product_id: ids.ok, name: "LC Test Ok", landing_cost_amd: 3900 },
      { erp_product_id: ids.none, name: "LC Test No Pack", brand: "Castrol", unit: "1L", unit_price_amd: 9000, landing_cost_amd: 4100 },
      // pack data wrong in Excel (cost 10x): the calculation is far from the workbook's number, so the workbook's value stays
      { ...pack, erp_product_id: ids.bad, name: "LC Test Outlier", pack_cost_usd: 240, landing_cost_amd: 3900 },
    ]);
    assert.equal(res.status, 200);

    const ok = await landing(ids.ok);
    assert.equal(ok.landing_source, "calculated");
    assert.equal(Number(ok.landing_workbook_amd), 3900);
    const { landingCost, COST_RATES_DEFAULT } = await import("../../../client/public/js/costModel.js");
    const expected = landingCost({ brand: "Castrol", size: 1, items: 4, packKg: 3.6, packCostUsd: 24 }, { ...COST_RATES_DEFAULT, rate: 366 }).amd;
    assert.ok(Math.abs(Number(ok.landing_cost_amd) - expected) < 0.01, `expected ${expected}, got ${ok.landing_cost_amd}`);

    const none = await landing(ids.none);
    assert.equal(none.landing_source, "workbook");
    assert.equal(Number(none.landing_cost_amd), 4100);
    const bad = await landing(ids.bad);
    assert.equal(bad.landing_source, "workbook", "an outlier keeps the workbook's value");
    assert.equal(Number(bad.landing_cost_amd), 3900);

    // A new rate recalculates every product at once; switching the calculation off falls back to the workbook everywhere.
    await apiRequest("/api/settings", { method: "PATCH", cookie, body: { landing_usd_rate: 400 } });
    const higher = await landing(ids.ok);
    assert.ok(Number(higher.landing_cost_amd) > Number(ok.landing_cost_amd) * 1.05, "a higher rate raises the landing cost");
    await apiRequest("/api/settings", { method: "PATCH", cookie, body: { landing_calc_enabled: false } });
    const off = await landing(ids.ok);
    assert.equal(off.landing_source, "workbook");
    assert.equal(Number(off.landing_cost_amd), 3900);

    // A later sync from an older bot (no pack fields) neither clears the pack data nor the calculated value.
    await apiRequest("/api/settings", { method: "PATCH", cookie, body: { landing_calc_enabled: true, landing_usd_rate: 366 } });
    await send([{ erp_product_id: ids.ok, name: "LC Test Ok", brand: "Castrol", unit: "1L", unit_price_amd: 9000, landing_cost_amd: 3900 }]);
    const again = await landing(ids.ok);
    assert.equal(again.landing_source, "calculated");
    assert.ok(Math.abs(Number(again.landing_cost_amd) - expected) < 0.01);

    const bounds = await apiRequest("/api/settings", { method: "PATCH", cookie, body: { landing_usd_rate: 5 } });
    assert.equal(bounds.status, 400);
  } finally {
    await pool.query("DELETE FROM products WHERE erp_product_id = ANY($1)", [Object.values(ids)]);
    await pool.query("UPDATE app_settings SET landing_calc_enabled = $1, landing_usd_rate = $2 WHERE id = 1", [saved.landing_calc_enabled, saved.landing_usd_rate]);
  }
});

// Freight, customs, excise, ... set in App configuration (owner, 2026-10-20) feed the same calculation.
// Settings are restored afterwards: this suite also runs against the production database on deploy.
test("PATCH /api/settings landing_rates: freight, customs and excise recalculate every landing cost; bad values are refused; null resets", async () => {
  const erpId = `ITEST-LR-${Date.now()}`;
  const saved = (await pool.query("SELECT landing_calc_enabled, landing_usd_rate, landing_cost_rates FROM app_settings WHERE id = 1")).rows[0];
  const admin = await createUser("admin");
  const cookie = await loginAs(admin.email);
  const patch = (landing_rates) => apiRequest("/api/settings", { method: "PATCH", cookie, body: { landing_rates } });
  const landing = async () => Number((await pool.query("SELECT landing_cost_amd FROM products WHERE erp_product_id = $1", [erpId])).rows[0].landing_cost_amd);
  try {
    await apiRequest("/api/settings", { method: "PATCH", cookie, body: { landing_calc_enabled: true, landing_usd_rate: 366 } });
    await patch({ tRealCastrol: null, customs: null, excise: null }); // start from the built-in values
    const sync = await syncRequest(
      { customers: [], products: [{ erp_product_id: erpId, name: "LR Test", brand: "Castrol", unit: "1L", unit_price_amd: 9000, pack_cost_usd: 24, items_per_pack: 4, pack_netto_kg: 3.6, size_l: 1, landing_cost_amd: 3900 }] },
      { "X-Sync-Key": SYNC_KEY, ...BYPASS }
    );
    assert.equal(sync.status, 200);
    const { landingCost, COST_RATES_DEFAULT } = await import("../../../client/public/js/costModel.js");
    const pack = { brand: "Castrol", size: 1, items: 4, packKg: 3.6, packCostUsd: 24 };
    const base = await landing();
    assert.ok(Math.abs(base - landingCost(pack, { ...COST_RATES_DEFAULT, rate: 366 }).amd) < 0.01);

    const get = await apiRequest("/api/settings", { cookie });
    assert.equal(get.data.landing_rates.customs, COST_RATES_DEFAULT.customs);
    assert.equal(get.data.landing_rate_defaults.excise, COST_RATES_DEFAULT.excise);

    // dearer freight, customs and excise raise the cost at once, and the response carries the rates now in use
    const changed = await patch({ tRealCastrol: 0.4, customs: 10, excise: 900 });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.landing_rates.customs, 10);
    const expected = landingCost(pack, { ...COST_RATES_DEFAULT, rate: 366, tRealCastrol: 0.4, customs: 10, excise: 900 }).amd;
    const after = await landing();
    assert.ok(after > base, "dearer rates raise the landing cost");
    assert.ok(Math.abs(after - expected) < 0.01, `expected ${expected}, got ${after}`);

    // a value equal to the built-in one is not stored as an override
    await patch({ customs: COST_RATES_DEFAULT.customs });
    assert.equal(((await pool.query("SELECT landing_cost_rates FROM app_settings WHERE id = 1")).rows[0].landing_cost_rates).customs, undefined);

    // refused: unknown key, outside the allowed range, not a number, not an object -- and nothing was saved
    for (const bad of [{ nonsense: 1 }, { customs: 500 }, { excise: -1 }, { vat: "abc" }, [1, 2]]) {
      assert.equal((await patch(bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await apiRequest("/api/settings", { cookie })).data.landing_rates.excise, 900);

    // null puts a rate back to the built-in value and the landing cost returns to the original
    await patch({ tRealCastrol: null, excise: null });
    assert.ok(Math.abs((await landing()) - base) < 0.01);
  } finally {
    await pool.query("DELETE FROM products WHERE erp_product_id = $1", [erpId]);
    await pool.query("UPDATE app_settings SET landing_calc_enabled = $1, landing_usd_rate = $2, landing_cost_rates = $3 WHERE id = 1", [saved.landing_calc_enabled, saved.landing_usd_rate, saved.landing_cost_rates]);
  }
});

test("POST /api/erp-sync: Retail price from Excel is stored, listed as a difference, and only applied while the switch is on", async () => {
  const erpId = `ITEST-RETAIL-${Date.now()}`;
  const saved = (await pool.query("SELECT retail_from_excel FROM app_settings WHERE id = 1")).rows[0];
  const admin = await createUser("admin");
  const cookie = await loginAs(admin.email);
  const send = (retail) =>
    syncRequest({ customers: [], products: [{ erp_product_id: erpId, name: "Retail Test Oil", brand: "Castrol", unit: "1L", unit_price_amd: 9000, retail_price_amd: retail }] }, { "X-Sync-Key": SYNC_KEY, ...BYPASS });
  const row = async () => (await pool.query("SELECT id, retail_price_amd, erp_retail_price_amd, manually_edited_at FROM products WHERE erp_product_id = $1", [erpId])).rows[0];
  try {
    await apiRequest("/api/settings", { method: "PATCH", cookie, body: { retail_from_excel: false } });
    await send(12000);
    let p = await row();
    assert.equal(Number(p.erp_retail_price_amd), 12000, "the workbook's retail price is always stored");
    assert.notEqual(Number(p.retail_price_amd), 12000, "but not applied while the switch is off");
    // an admin hand-edit must not stop Excel from winning once the switch is on (the owner's rule for every Excel price)
    await pool.query("UPDATE products SET retail_price_amd = 11000, manually_edited_at = now() WHERE id = $1", [p.id]);

    const diff = await apiRequest("/api/settings/retail-differences", { cookie });
    assert.equal(diff.status, 200);
    const mine = diff.data.products.find((d) => d.id === p.id);
    assert.deepEqual([mine.app_retail, mine.excel_retail], [11000, 12000]);

    const on = await apiRequest("/api/settings", { method: "PATCH", cookie, body: { retail_from_excel: true } });
    assert.equal(on.data.retail_from_excel, true);
    p = await row();
    assert.equal(Number(p.retail_price_amd), 12000);
    const history = (await pool.query("SELECT old_value, new_value FROM product_price_history WHERE product_id = $1 AND price_type = 'retail' ORDER BY id DESC LIMIT 1", [p.id])).rows[0];
    assert.deepEqual([Number(history.old_value), Number(history.new_value)], [11000, 12000]);

    await send(12500); // Excel changes the price: the next upload follows
    assert.equal(Number((await row()).retail_price_amd), 12500);
    await send(null); // a blank Retail Price never wipes the stored one
    assert.equal(Number((await row()).retail_price_amd), 12500);

    const forRep = await apiRequest("/api/settings/retail-differences", { cookie: await loginAs((await createUser("sales_manager")).email) });
    assert.equal(forRep.status, 403);
  } finally {
    await pool.query("DELETE FROM product_price_history WHERE product_id IN (SELECT id FROM products WHERE erp_product_id = $1)", [erpId]);
    await pool.query("DELETE FROM products WHERE erp_product_id = $1", [erpId]);
    await pool.query("UPDATE app_settings SET retail_from_excel = $1 WHERE id = 1", [saved.retail_from_excel]);
  }
});

// 2026-10-24: the returns step threw on a database without migration 143 and the whole sync rolled back, so nothing was updated. An optional
// step now runs in a SAVEPOINT: its failure is reported, the rest of the transaction (the sync) goes on.
test("optionalSyncStep: a failing derived step is skipped, the transaction stays usable and the failure is reported", async () => {
  const { optionalSyncStep } = await import("../../src/erp/routes/erpSync.js");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const warnings = [];
    const out = await optionalSyncStep(client, "match returns", () => client.query("SELECT 1 FROM table_that_does_not_exist_144"), warnings);
    assert.equal(out, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /match returns/);
    assert.equal((await client.query("SELECT 7 AS n")).rows[0].n, 7, "the transaction must still be usable");
    assert.equal(await optionalSyncStep(client, "ok step", async () => 42, warnings), 42);
    assert.equal(warnings.length, 1);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});
