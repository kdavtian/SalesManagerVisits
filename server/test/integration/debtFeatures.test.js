// Debt follow-ups: soft credit hold warning, debt statement PDF, money-ranked "visit first" list and
// the weekly debt digest.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { debtHoldInfo, DEBT_HOLD_DAYS } from "../../src/debtAge.js";
import { buildDebtSnapshot, compareSnapshots, formatDigest, sendWeeklyDebtDigest } from "../../src/debtDigest.js";
import { yerevanToday } from "../../src/utils/yerevanDate.js";

const stamp = Date.now();
const erpIds = [];
const SNAPSHOT_DATES = ["2098-12-29", "2099-01-05"];
let admin, ceo, rep, repCookie, adminCookie, old, fresh, today;

async function debtor(name, debt, orders) {
  const erpId = `ITEST-DF-${name}-${stamp}`;
  erpIds.push(erpId);
  const c = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: erpId, sales_channel: "retail", name: `DF ${name} ${stamp}` });
  await pool.query("UPDATE customers SET credit_term_days = 45 WHERE id = $1", [c.id]);
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, synced_at) VALUES ($1, 'x', $2, 0, now())", [erpId, debt]);
  for (const [id, ago, total] of orders) {
    await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Yerevan')::date - $3::int, $4)", [erpId, `${id}-${stamp}`, ago, total]);
  }
  return { ...c, erpId };
}

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  ceo = await createUser("ceo");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  today = yerevanToday();
  // Debt 800,000: 300,000 (10 days ago) + 350,000 (70 days) + 150,000 of a 400,000 order 200 days ago -> oldest 155 days past due.
  old = await debtor("old", 800000, [["N1", 10, 300000], ["N2", 70, 350000], ["N3", 200, 400000]]);
  // Debt 100,000 = the last order of 5 days ago: not due yet.
  fresh = await debtor("fresh", 100000, [["F1", 5, 100000]]);
});
test.after(async () => {
  await pool.query("DELETE FROM debt_digest_snapshots WHERE snapshot_date = ANY($1)", [SNAPSHOT_DATES]);
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [erpIds]);
  await cleanupAll();
  await stopTestServer();
});

test("credit hold: a customer whose oldest unpaid invoice is more than 90 days past due is flagged (warning only)", async () => {
  const hold = await debtHoldInfo(pool, old.id, today);
  assert.equal(hold.oldest_due_days, 155);
  assert.equal(hold.on_hold, true);
  assert.equal(hold.overdue_amd, 500000);
  assert.equal(hold.hold_days, DEBT_HOLD_DAYS);
  const ok = await debtHoldInfo(pool, fresh.id, today);
  assert.equal(ok.on_hold, false);

  const res = await apiRequest(`/api/customers/${old.id}/credit-status`, { cookie: repCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.debt_hold.on_hold, true);
  assert.equal(res.data.debt_hold.oldest_due_days, 155);
  assert.equal((await apiRequest(`/api/customers/${fresh.id}/credit-status`, { cookie: repCookie })).data.debt_hold.on_hold, false);
});

test("debt statement PDF: only with debt and only for people who see the debt", async () => {
  const res = await apiRequest(`/api/customers/${old.id}/debt-statement`, { cookie: repCookie });
  assert.equal(res.status, 200);
  assert.ok(String(res.data).startsWith("%PDF"));
  assert.equal((await apiRequest(`/api/customers/${old.id}/debt-statement`, { cookie: adminCookie })).status, 200);
  const other = await createUser("sales_manager");
  assert.equal((await apiRequest(`/api/customers/${old.id}/debt-statement`, { cookie: await loginAs(other.email) })).status, 403);
  const clean = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, name: `DF clean ${stamp}` });
  assert.equal((await apiRequest(`/api/customers/${clean.id}/debt-statement`, { cookie: repCookie })).status, 400);
  assert.equal((await apiRequest("/api/customers/999999999/debt-statement", { cookie: adminCookie })).status, 404);
});

test("visit first: the bigger overdue amount ranks higher and the money at stake is returned", async () => {
  const lone = await createUser("sales_manager");
  const loneCookie = await loginAs(lone.email);
  const mk = async (name, debt) => {
    const erpId = `ITEST-DF-${name}-${stamp}`;
    erpIds.push(erpId);
    const c = await createCustomer({ created_by: admin.id, assigned_manager_id: lone.id, erp_customer_id: erpId, name: `DF ${name} ${stamp}` });
    await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, synced_at) VALUES ($1, 'x', $2, 0, now())", [erpId, debt]);
    return c;
  };
  const small = await mk("psmall", 100000);
  const big = await mk("pbig", 3000000);
  const res = await apiRequest("/api/customers/visit-priorities", { cookie: loneCookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.map((r) => r.customer_id), [big.id, small.id]);
  assert.equal(res.data[0].money_amd, 3000000);
  assert.ok(res.data[0].score > res.data[1].score);
  assert.equal(res.data[0].reasons.find((r) => r.type === "debt").amount, 3000000);
});

test("debt digest: snapshot, comparison with last week and the Monday-once send", async () => {
  const snap = await buildDebtSnapshot(pool, today);
  assert.equal(snap.customers[old.id].debt, 800000);
  assert.equal(snap.customers[old.id].overdue, 500000);
  assert.equal(snap.customers[fresh.id].overdue, 0);
  assert.ok(snap.by_bucket.d90_plus >= 150000);

  // Pure comparison: totals, overdue and the biggest movers (both directions).
  const prev = { total_debt_amd: 1000, overdue_amd: 600, by_bucket: {}, customers: { 1: { name: "A", debt: 500, overdue: 400 }, 2: { name: "B", debt: 500, overdue: 200 } } };
  const cur = { total_debt_amd: 1200, overdue_amd: 500, by_bucket: { d90_plus: 100, opening: 50 }, customers: { 1: { name: "A", debt: 300, overdue: 100 }, 3: { name: "C", debt: 900, overdue: 400 } } };
  const cmp = compareSnapshots(cur, prev);
  assert.equal(cmp.delta_total, 200);
  assert.equal(cmp.delta_overdue, -100);
  assert.equal(cmp.over90_amd, 150);
  assert.equal(cmp.customers_overdue, 2);
  assert.deepEqual(cmp.movers.map((m) => [m.name, m.delta]), [["C", 400], ["A", -300], ["B", -200]]);
  assert.equal(compareSnapshots(cur, null).delta_total, null);
  assert.match(formatDigest(cur, cmp, "2099-01-05").telegram, /05\.01\.2099/);

  // Not on a Tuesday, not before 09:00, and only once on the Monday.
  assert.equal(await sendWeeklyDebtDigest(new Date("2099-01-06T10:00:00+04:00")), 0); // Tuesday
  assert.equal(await sendWeeklyDebtDigest(new Date("2099-01-05T08:00:00+04:00")), 0); // Monday before 09:00
  await pool.query(
    "INSERT INTO debt_digest_snapshots (snapshot_date, total_debt_amd, overdue_amd, by_bucket, customers) VALUES ('2098-12-29', 1000, 100, '{}', $1)",
    [JSON.stringify({ [old.id]: { name: "x", debt: 500000, overdue: 100000 } })]
  );
  const monday = new Date("2099-01-05T10:00:00+04:00");
  assert.ok((await sendWeeklyDebtDigest(monday)) >= 1);
  const { rows } = await pool.query("SELECT title, body FROM notifications WHERE user_id = $1 AND type = 'debt_digest'", [ceo.id]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /ժամկետանց/);
  assert.equal(await sendWeeklyDebtDigest(monday), 0, "once per Monday");
  const saved = await pool.query("SELECT customers FROM debt_digest_snapshots WHERE snapshot_date = '2099-01-05'");
  assert.equal(saved.rowCount, 1);
  assert.equal(saved.rows[0].customers[old.id].overdue, 800000); // computed as of 2099: everything is long overdue
});
