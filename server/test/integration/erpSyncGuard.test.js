// Improvement plan 0.5 (owner, 2026-11-28): an empty or half-saved Excel file must not wipe the debts. A sync whose counts drop more than 20 %
// against the last good sync is refused with 422 and changes nothing; the refusal is recorded (failed attempt + System health) and a real
// change gets through with `force: true` or the admin's "Accept the next sync". Same guard on the bot's Cashflow-ledger push.
// Plan 0.9: a dollar row without a rate takes the nearest rate, or is kept and flagged; the count is in the push result and on the Cashflow meta.
// Global state (the last sync's counts, app_settings): listed in isolated-tests.txt.
process.env.ERP_SYNC_KEY = "itest-sync-key";
process.env.E2E_RATE_LIMIT_BYPASS_TOKEN = "itest-bypass";
const KEY = { "X-Sync-Key": "itest-sync-key", "x-e2e-rate-limit-bypass": "itest-bypass" };

import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let adminCookie, repCookie, accountantCookie;
const RUN = `G${process.pid}${Date.now() % 100000}`;
test.before(async () => {
  await startTestServer();
  adminCookie = await loginAs((await createUser("admin")).email);
  repCookie = await loginAs((await createUser("sales_manager")).email);
  accountantCookie = await loginAs((await createUser("accountant")).email);
});
test.after(async () => {
  await pool.query("UPDATE app_settings SET erp_sync_refusals = '{}', erp_sync_accept_until = NULL, erp_sync_accept_by = NULL, erp_sync_accept_used = '{}' WHERE id = 1");
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id LIKE $1", [`${RUN}%`]);
  await pool.query("DELETE FROM cash_entries WHERE origin = 'excel' AND info LIKE $1", [`${RUN}%`]);
  await cleanupAll();
  await stopTestServer();
});

const sync = (body) => apiRequest("/api/erp-sync", { method: "POST", body, headers: KEY });
const ledger = (body) => apiRequest("/api/erp-sync/cashflow-ledger", { method: "POST", body, headers: KEY });
const customers = (n, debtors = n) =>
  Array.from({ length: n }, (_, i) => ({ erp_customer_id: `${RUN}-${i}`, customer_name: `Guard Shop ${i}`, debt_amd: i < debtors ? 1000 + i : 0 }));
const debtTotal = async () => Number((await pool.query("SELECT COALESCE(SUM(debt_amd), 0) AS s FROM erp_customer_data WHERE erp_customer_id LIKE $1", [`${RUN}%`])).rows[0].s);

const orderLines = (n) => Array.from({ length: n }, (_, i) => ({ erp_customer_id: `${RUN}-0`, order_id: `${RUN}-O${i}`, date: "2031-01-05", product_id: "P1", qty: 1, revenue_amd: 100 }));
const orderCount = async () => (await pool.query("SELECT count(*)::int AS n FROM erp_order_lines WHERE order_id LIKE $1", [`${RUN}%`])).rows[0].n;

test("a good full sync, then an empty file: refused with 422, debts kept, refusal recorded and shown in System health", async () => {
  const good = await sync({ customers: customers(120), order_lines: orderLines(60) });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  const before = await debtTotal();
  assert.ok(before > 0);
  const run = (await pool.query("SELECT counts FROM erp_sync_runs ORDER BY id DESC LIMIT 1")).rows[0].counts;
  assert.equal(run.customers, 120);
  assert.equal(run.customers_with_debt, 120, "the run now remembers how many customers owe");

  assert.equal(await orderCount(), 60);
  const empty = await sync({ customers: [], order_lines: [] });
  assert.equal(empty.status, 422);
  assert.equal(empty.data.code, "sync_drop_refused");
  assert.match(empty.data.error, /customers: 120 → 0/);
  assert.deepEqual(empty.data.drops.map((d) => d.key), ["customers", "customers_with_debt", "order_lines"]);
  assert.equal(await debtTotal(), before, "nothing was wiped");
  assert.equal(await orderCount(), 60, "the order history was not wiped either");

  const attempt = (await pool.query("SELECT ok, error FROM erp_sync_attempts WHERE endpoint = '/api/erp-sync' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(attempt.ok, false);
  assert.match(attempt.error, /Big drop/);
  const st = await apiRequest("/api/erp-sync/status", { cookie: adminCookie });
  assert.equal(st.status, 200);
  assert.equal(st.data.guard.refused_open, true);
  assert.equal(st.data.guard.refusals.length, 1);
  assert.equal(st.data.guard.refusals[0].endpoint, "/api/erp-sync");
  assert.match(st.data.guard.refusals[0].reason, /customers: 120 → 0/);
  assert.equal(st.data.guard.refusals[0].accepted, false);
  assert.match(st.data.last_failure.error, /Big drop/);
  assert.equal(st.data.last_success.counts.customers, 120, "the last good sync is unchanged");
  // order lines alone halving (customers fine) is refused too
  const halfOrders = await sync({ customers: customers(120), order_lines: orderLines(20) });
  assert.equal(halfOrders.status, 422);
  assert.deepEqual(halfOrders.data.drops.map((d) => d.key), ["order_lines"]);
  assert.equal(await orderCount(), 60);
});

test("the baseline of a list survives many syncs that did not send it (not only the last 30)", async () => {
  await pool.query("INSERT INTO erp_sync_runs (counts) SELECT '{\"customers\": 120, \"customers_with_debt\": 120}'::jsonb FROM generate_series(1, 35)");
  const res = await sync({ customers: customers(120), order_lines: [] });
  assert.equal(res.status, 422);
  assert.deepEqual(res.data.drops.map((d) => d.key), ["order_lines"]);
  assert.equal(await orderCount(), 60);
});

test("debtors dropping alone (half-saved debt column) is refused too; a small real change goes through", async () => {
  const halfDebts = await sync({ customers: customers(120, 60) });
  assert.equal(halfDebts.status, 422);
  assert.deepEqual(halfDebts.data.drops.map((d) => d.key), ["customers_with_debt"]);
  const small = await sync({ customers: customers(110), order_lines: orderLines(60) });
  assert.equal(small.status, 200, "an 8 % drop is normal life");
  const st = await apiRequest("/api/erp-sync/status", { cookie: adminCookie });
  assert.equal(st.data.guard.refused_open, false, "a good sync after the refusal closes it");
});

test("force: true from the bot lets a real big change through, and it is recorded", async () => {
  const res = await sync({ customers: customers(30), force: true });
  assert.equal(res.status, 200);
  const rec = (await pool.query("SELECT ok, warnings FROM erp_sync_attempts WHERE endpoint = '/api/erp-sync' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(rec.ok, true);
  assert.match(rec.warnings[0], /Big drop let through \(the bot's force flag\): customers: 110 → 30/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM erp_customer_data WHERE erp_customer_id LIKE $1", [`${RUN}%`])).rows[0].n, 30);
  // back to a big baseline for the next test
  assert.equal((await sync({ customers: customers(120), force: true })).status, 200);
});

test("only admin / CEO accept the next sync; it lets ONE big drop through, a second bad file is refused again", async () => {
  assert.equal((await sync({ customers: customers(10) })).status, 422);
  assert.equal((await apiRequest("/api/erp-sync/accept-drop", { method: "POST", cookie: repCookie })).status, 403);
  assert.equal((await apiRequest("/api/erp-sync/accept-drop", { method: "POST" })).status, 401);
  const ok = await apiRequest("/api/erp-sync/accept-drop", { method: "POST", cookie: adminCookie });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.accept_until);
  const st = await apiRequest("/api/erp-sync/status", { cookie: adminCookie });
  assert.ok(st.data.guard.accept_until);
  assert.equal((await sync({ customers: customers(10) })).status, 200);
  const rec = (await pool.query("SELECT warnings FROM erp_sync_attempts WHERE endpoint = '/api/erp-sync' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.match(rec.warnings[0], /accepted by /);
  // the accept is used up for the main sync; the window stays open for the Cashflow push of the same file only
  const after = await apiRequest("/api/erp-sync/status", { cookie: adminCookie });
  assert.deepEqual(after.data.guard.accept_used, ["/api/erp-sync"]);
  assert.equal((await sync({ customers: customers(120), force: true })).status, 200);
  assert.equal((await sync({ customers: customers(10) })).status, 422, "a second bad file in the same window is refused");
  const again = await apiRequest("/api/erp-sync/status", { cookie: adminCookie });
  const mainRef = again.data.guard.refusals.find((r) => r.endpoint === "/api/erp-sync");
  assert.equal(mainRef.accepted, false, "the card offers the accept button again for the main sync");
  await pool.query("UPDATE app_settings SET erp_sync_accept_until = NULL, erp_sync_accept_used = '{}' WHERE id = 1");
});

test("the bot's Cashflow push: a half sheet is refused and the ledger kept; dollar rows without a rate take the nearest rate or are flagged", async () => {
  const rows = Array.from({ length: 80 }, (_, i) => ({ date: "2031-05-01", amount: 1000 + i, currency: "AMD", for: "Fuel", source: `Cash ${RUN}`, info: `${RUN} row ${i}` }));
  rows.push({ date: "2031-05-02", amount: 10, currency: "USD", currency_rate: 390, for: "Investment", source: `Bank ${RUN} USD`, info: `${RUN} usd rate` });
  rows.push({ date: "2031-05-03", amount: 100, currency: "USD", for: "Investment", source: `Bank ${RUN} USD`, info: `${RUN} usd no rate` });
  const full = await ledger({ rows, file_name: "itest-guard.xlsx" });
  assert.equal(full.status, 200, JSON.stringify(full.data));
  assert.equal(full.data.usd_rate_filled, 1, "the result says how many rows took the nearest rate");
  assert.equal(full.data.usd_no_rate, 0);
  const filled = (await pool.query("SELECT fx_rate::float8 AS r, amount_amd::float8 AS a, fx_missing FROM cash_entries WHERE info = $1", [`${RUN} usd no rate`])).rows[0];
  assert.deepEqual(filled, { r: 390, a: 39000, fx_missing: false }, "not 0 AMD any more");
  assert.equal((await pool.query("SELECT fx_estimated FROM cash_entries WHERE info = $1", [`${RUN} usd no rate`])).rows[0].fx_estimated, true);

  const half = await ledger({ rows: rows.slice(0, 20) });
  assert.equal(half.status, 422);
  assert.equal(half.data.code, "sync_drop_refused");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cash_entries WHERE origin = 'excel'")).rows[0].n, 82, "the ledger was not wiped");
  // a good MAIN sync afterwards does not hide the refused Cashflow sheet
  assert.equal((await sync({ customers: customers(120) })).status, 200);
  const st = await apiRequest("/api/erp-sync/status", { cookie: adminCookie });
  assert.equal(st.data.guard.refused_open, true, "still open: only a good Cashflow push closes it");
  assert.deepEqual(st.data.guard.refusals.map((r) => r.endpoint), ["/api/erp-sync/cashflow-ledger"]);
  // a main-sync refusal now does not overwrite the Cashflow one, and a good main sync closes only its own
  assert.equal((await sync({ customers: customers(10) })).status, 422);
  const both = await apiRequest("/api/erp-sync/status", { cookie: adminCookie });
  assert.deepEqual(both.data.guard.refusals.map((r) => r.endpoint).sort(), ["/api/erp-sync", "/api/erp-sync/cashflow-ledger"]);
  assert.equal((await sync({ customers: customers(120) })).status, 200);
  const one = await apiRequest("/api/erp-sync/status", { cookie: adminCookie });
  assert.deepEqual(one.data.guard.refusals.map((r) => r.endpoint), ["/api/erp-sync/cashflow-ledger"]);
  // the admin's accept lets one Cashflow push through, then the ledger guard is back
  await apiRequest("/api/erp-sync/accept-drop", { method: "POST", cookie: adminCookie });
  assert.equal((await ledger({ rows: rows.slice(0, 60) })).status, 200);
  assert.equal((await apiRequest("/api/erp-sync/status", { cookie: adminCookie })).data.guard.refused_open, false);
  assert.equal((await ledger({ rows: rows.slice(0, 10) })).status, 422, "used up");
  assert.equal((await ledger({ rows, force: true })).status, 200, "force works on the Cashflow push too");
  await pool.query("UPDATE app_settings SET erp_sync_accept_until = NULL, erp_sync_accept_used = '{}' WHERE id = 1");

  // the sheet loses its only typed rate: the no-rate row takes the app's typed rate (390) and keeps it on a repeat of the same file,
  // although the typed row it came from is replaced by the first refresh
  const noTyped = [...rows.filter((r) => r.currency === "AMD"), { date: "2031-05-03", amount: 100, currency: "USD", for: "Investment", source: `Bank ${RUN} USD`, info: `${RUN} usd fallback` }];
  for (let i = 0; i < 2; i++) {
    const again = await ledger({ rows: noTyped });
    assert.equal(again.status, 200, JSON.stringify(again.data));
    assert.equal(again.data.usd_rate_filled, 1, `refresh ${i + 1}`);
    assert.equal(Number((await pool.query("SELECT amount_amd FROM cash_entries WHERE info = $1", [`${RUN} usd fallback`])).rows[0].amount_amd), 39000, `refresh ${i + 1}`);
  }

  // no dollar rate in the sheet and none in the app: kept, flagged, counted, shown on the Cashflow meta with its Excel row
  await pool.query("UPDATE cash_entries SET fx_rate = NULL WHERE currency = 'USD'");
  await pool.query("UPDATE cash_syncs SET fallback_rate = NULL");
  const noRate = [...rows.filter((r) => r.currency === "AMD"), { date: "2031-05-03", amount: 100, currency: "USD", for: "Investment", source: `Bank ${RUN} USD`, info: `${RUN} usd none`, excel_row: 777 }];
  const res = await ledger({ rows: noRate });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.usd_no_rate, 1);
  const kept = (await pool.query("SELECT amount_amd::float8 AS a, fx_missing FROM cash_entries WHERE info = $1", [`${RUN} usd none`])).rows[0];
  assert.deepEqual(kept, { a: 0, fx_missing: true });
  const meta = await apiRequest("/api/cashflow/meta", { cookie: accountantCookie });
  assert.equal(meta.status, 200);
  assert.equal(meta.data.no_rate.n, 1);
  assert.deepEqual(meta.data.no_rate.excel_rows, [777]);
  assert.equal(meta.data.last_sync.rows_no_rate, 1);
});
