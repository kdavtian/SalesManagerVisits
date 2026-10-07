// Debt-as-of-date: GET /api/reports/customer-debt and GET /api/debt-balances
// with a ?date= param. Both now compute the same absolute running balance:
// balance0_amd (the Castrol Excel Debits sheet's own opening-balance
// column, see migration 083) + SUM(order_lines.revenue_amd <= D) -
// SUM(cashflow_lines.amount_amd <= D). An earlier version of this formula
// omitted balance0_amd (not yet synced) and was reported live as wildly
// overstating historical debt whenever a customer's erp_cashflow_lines
// history was much thinner than their erp_order_lines history -- balance0
// is the true opening balance carried forward from before that thin
// cashflow history began, so including it is what makes the absolute sum
// correct instead of just an approximation anchored on "today".
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const ERP_CUSTOMER_ID = `itest-debt-asof-${Date.now()}`;

let adminCookie;
let customer;

// balance0_amd (35000) + all-time orders (50000+30000=80000) - net all-time
// cashflow (20000-5000=15000) = 100000, matching the live debt_amd fixture
// below by design -- the property that makes "as of today" agree with
// "live" (see the "matches live" test further down) depends on balance0
// actually being the customer's real opening balance, not an arbitrary
// number, so the fixture is deliberately self-consistent rather than
// picking balance0 and debt_amd independently.
test.before(async () => {
  await startTestServer();
  const admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
  customer = await createCustomer({ created_by: admin.id, erp_customer_id: ERP_CUSTOMER_ID });

  await pool.query(
    `INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, synced_at)
     VALUES ($1, 'Itest Debt Customer', 100000, 35000, now())`,
    [ERP_CUSTOMER_ID]
  );

  // Orders: 50000 on 2026-01-10, 30000 on 2026-02-10 (80000 all-time).
  await pool.query(
    `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd)
     VALUES ($1, 'ORD-1', '2026-01-10', 50000), ($1, 'ORD-2', '2026-02-10', 30000)`,
    [ERP_CUSTOMER_ID]
  );
  // Cashflow: 20000 payment on 2026-01-15, -5000 refund on 2026-02-20.
  await pool.query(
    `INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd)
     VALUES ($1, '2026-01-15', 20000), ($1, '2026-02-20', -5000)`,
    [ERP_CUSTOMER_ID]
  );
});
test.after(async () => {
  await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [ERP_CUSTOMER_ID]);
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [ERP_CUSTOMER_ID]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [ERP_CUSTOMER_ID]);
  await cleanupAll();
  await stopTestServer();
});

test("GET /api/reports/customer-debt: without ?date= uses the live erp_customer_data.debt_amd snapshot", async () => {
  const res = await apiRequest("/api/reports/customer-debt", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const row = res.data.customers.find((c) => c.erp_customer_id === ERP_CUSTOMER_ID);
  assert.equal(Number(row.debt_amd), 100000);
  assert.equal(res.data.as_of_date, null);
});

test("GET /api/reports/customer-debt?date=: computes balance0 plus a running balance from order/cashflow history, ignoring later entries", async () => {
  // As of 2026-01-20: 35000 balance0 + 50000 order (Jan 10) - 20000 payment
  // (Jan 15) = 65000. The Feb order and Feb refund are both after this
  // date and excluded.
  const res = await apiRequest("/api/reports/customer-debt?date=2026-01-20", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.as_of_date, "2026-01-20");
  const row = res.data.customers.find((c) => c.erp_customer_id === ERP_CUSTOMER_ID);
  assert.equal(Number(row.estimated_debt_amd), 65000);
});

test("GET /api/reports/customer-debt?date=: a refund after the debt-clearing point nets back into the balance", async () => {
  // As of 2026-02-28 (everything included): 35000 + (50000+30000) - (20000-5000) = 100000.
  const res = await apiRequest("/api/reports/customer-debt?date=2026-02-28", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const row = res.data.customers.find((c) => c.erp_customer_id === ERP_CUSTOMER_ID);
  assert.equal(Number(row.estimated_debt_amd), 100000);
});

test("GET /api/debt-balances?date=: computes balance0 plus a running balance from order/cashflow history, ignoring later entries", async () => {
  // As of 2026-01-20: 35000 balance0 + 50000 order (Jan 10) - 20000 payment
  // (Jan 15) = 65000. The Feb order and Feb refund are both after this
  // date and excluded.
  const res = await apiRequest("/api/debt-balances?date=2026-01-20", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.as_of_date, "2026-01-20");
  const row = res.data.rows.find((r) => r.customer_id === ERP_CUSTOMER_ID);
  assert.equal(Number(row.remaining_balance), 65000);
});

test("GET /api/debt-balances?date=: a date covering the customer's full history matches the live figure", async () => {
  // Nothing in this customer's history falls after 2026-03-01 (last entry
  // is the Feb 20 refund), so the as-of balance (35000 + 80000 - 15000 =
  // 100000) must equal live debt_amd exactly -- the fixture's balance0_amd
  // is deliberately set so this holds (see test.before's own comment);
  // this is the property that closes the originally-reported bug, now via
  // a correct absolute formula rather than an anchor-on-live workaround.
  const res = await apiRequest("/api/debt-balances?date=2026-03-01", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const row = res.data.rows.find((r) => r.customer_id === ERP_CUSTOMER_ID);
  assert.equal(Number(row.remaining_balance), 100000);
});

test("GET /api/debt-balances: without ?date= still uses the live snapshot", async () => {
  const res = await apiRequest("/api/debt-balances", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const row = res.data.rows.find((r) => r.customer_id === ERP_CUSTOMER_ID);
  assert.equal(Number(row.remaining_balance), 100000);
});

// Regression: reported live as "By date balances are wrong, Live is
// correct" -- for a customer with a large all-time order history but much
// thinner cashflow history, the absolute SUM(orders)-SUM(cashflow) formula
// (with no balance0_amd yet) summed ~all 10,000,000 AMD of orders ever
// placed against only the 100,000 AMD of cashflow the sync happened to
// carry, wildly overstating debt. balance0_amd -- the true opening balance
// carried forward from before the thin cashflow history began -- is what
// actually closes that gap: with it set correctly, the same formula lands
// exactly on the live figure instead of needing a live-anchored workaround.
const THIN_CASHFLOW_ERP_ID = `itest-debt-asof-thincashflow-${Date.now()}`;

test("GET /api/debt-balances?date=: balance0_amd closes the gap for a customer with thin cashflow history relative to orders", async () => {
  const admin = await createUser("admin");
  await createCustomer({ created_by: admin.id, erp_customer_id: THIN_CASHFLOW_ERP_ID });
  // balance0 (-9850000) + all-time orders (10000000) - all-time cashflow
  // (100000) = 50000, matching live debt_amd -- a large negative balance0
  // is exactly what it looks like to carry forward a customer whose real
  // payment history mostly predates what erp_cashflow_lines has on file.
  await pool.query(
    `INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, synced_at)
     VALUES ($1, 'Itest Thin Cashflow Customer', 50000, -9850000, now())`,
    [THIN_CASHFLOW_ERP_ID]
  );
  try {
    await pool.query(
      `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd)
       VALUES ($1, 'ORD-TC-1', '2026-01-01', 2000000), ($1, 'ORD-TC-2', '2026-03-01', 3000000), ($1, 'ORD-TC-3', '2026-05-01', 5000000)`,
      [THIN_CASHFLOW_ERP_ID]
    );
    await pool.query(
      `INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, '2026-02-01', 100000)`,
      [THIN_CASHFLOW_ERP_ID]
    );

    // As of a date after all of the above: -9850000 + 10000000 - 100000 =
    // 50000, exactly the live figure -- without balance0_amd this would
    // have come back as 9900000.
    const res = await apiRequest("/api/debt-balances?date=2026-09-01", { cookie: adminCookie });
    assert.equal(res.status, 200);
    const row = res.data.rows.find((r) => r.customer_id === THIN_CASHFLOW_ERP_ID);
    assert.ok(row);
    assert.equal(Number(row.remaining_balance), 50000);
  } finally {
    await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [THIN_CASHFLOW_ERP_ID]);
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [THIN_CASHFLOW_ERP_ID]);
    await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [THIN_CASHFLOW_ERP_ID]);
  }
});

// Regression: erp_customer_data is TRUNCATE-and-replaced on every sync, and
// a customer whose debt is now fully paid off drops out of it entirely
// (see migration 006's own comment) -- even though they can genuinely have
// owed money as of an earlier date. The as-of query used to drive FROM
// erp_customer_data, so a customer absent from today's snapshot was
// silently excluded from the historical calculation too, no matter what
// their actual order/cashflow history said. Reported live as "by date"
// debt balances coming out wrong while "live" was fine.
const PAID_OFF_ERP_ID = `itest-debt-asof-paidoff-${Date.now()}`;
let paidOffCustomer;

test("GET /api/debt-balances?date=: a customer no longer in the live erp_customer_data snapshot (fully paid off since) still shows their historical balance", async () => {
  const admin = await createUser("admin");
  paidOffCustomer = await createCustomer({ created_by: admin.id, erp_customer_id: PAID_OFF_ERP_ID });
  try {
    // Deliberately NO row inserted into erp_customer_data for this
    // customer -- simulating them having dropped out of the live extract
    // because their debt is fully paid as of today.
    // Orders: 40000 on 2026-01-05. Cashflow: 40000 payment on 2026-03-01
    // (after the as-of date below, so as of 2026-01-20 they still owed
    // the full amount).
    await pool.query(
      `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, 'ORD-PO-1', '2026-01-05', 40000)`,
      [PAID_OFF_ERP_ID]
    );
    await pool.query(
      `INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, '2026-03-01', 40000)`,
      [PAID_OFF_ERP_ID]
    );

    // Live mode: absent from erp_customer_data entirely, so they correctly
    // don't appear (debt actually is fully paid as of today).
    const liveRes = await apiRequest("/api/debt-balances", { cookie: adminCookie });
    assert.equal(
      liveRes.data.rows.some((r) => r.customer_id === PAID_OFF_ERP_ID),
      false
    );

    // As-of 2026-01-20: the 2026-03-01 payment hadn't happened yet, so
    // they genuinely owed the full 40000 -- and must show up even though
    // they're nowhere in the live snapshot.
    const asOfRes = await apiRequest("/api/debt-balances?date=2026-01-20", { cookie: adminCookie });
    assert.equal(asOfRes.status, 200);
    const row = asOfRes.data.rows.find((r) => r.customer_id === PAID_OFF_ERP_ID);
    assert.ok(row, "a customer absent from the live snapshot must still appear in a historical as-of view when they genuinely owed money then");
    assert.equal(Number(row.remaining_balance), 40000);
  } finally {
    await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [PAID_OFF_ERP_ID]);
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [PAID_OFF_ERP_ID]);
  }
});

// Regression: last_payment_date in an as-of view must never show a payment
// that happened *after* the date being viewed -- that would misrepresent
// what the historical balance was actually based on (it was previously
// always GREATEST(live ecd date, live app-payment date), unbounded by the
// as-of date).
test("GET /api/debt-balances?date=: last_payment_date is bounded to payments on or before the as-of date", async () => {
  // Itest Debt Customer (from test.before) has a 2026-01-15 cashflow
  // payment and no later ones before 2026-02-20's refund (not a payment).
  const res = await apiRequest("/api/debt-balances?date=2026-01-20", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const row = res.data.rows.find((r) => r.customer_id === ERP_CUSTOMER_ID);
  assert.ok(row);
  assert.equal(String(row.last_payment_date).slice(0, 10), "2026-01-15");
});

// Regression: reported live as "last payment date isn't showing" -- the
// live (no ?date=) branch only looked at erp_customer_data.last_payment_date
// (routinely blank from the external Excel pipeline) and in-app payments,
// never erp_cashflow_lines, even though that's the same sync's own full
// cashflow history and the as-of branch already trusted it. Itest Debt
// Customer (from test.before) has no erp_customer_data.last_payment_date
// and no in-app payment, only the 2026-01-15 cashflow payment -- live mode
// must surface it from cashflow instead of showing nothing.
test("GET /api/debt-balances (live): last_payment_date falls back to erp_cashflow_lines when the ERP sync's own column is blank", async () => {
  // Unlike the as-of branch (which drives from `customers` and tolerates a
  // missing erp_customer_data row), the live branch requires one to exist
  // with a non-zero debt_amd -- and erp_customer_data/erp_cashflow_lines
  // are both TRUNCATE-and-replaced wholesale by POST /api/erp-sync (see
  // that route), which other integration test files call while this one
  // runs concurrently (node --test runs files in parallel). Re-asserting
  // this fixture's rows immediately before the request, rather than
  // trusting test.before()'s one-time insert to still be there, closes
  // that race instead of leaving this test flaky under the full suite.
  await pool.query(
    `INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at)
     VALUES ($1, 'Itest Debt Customer', 100000, now())
     ON CONFLICT (erp_customer_id) DO UPDATE SET debt_amd = EXCLUDED.debt_amd, synced_at = now()`,
    [ERP_CUSTOMER_ID]
  );
  await pool.query(
    `INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd)
     SELECT $1, '2026-01-15', 20000
     WHERE NOT EXISTS (
       SELECT 1 FROM erp_cashflow_lines WHERE erp_customer_id = $1 AND cashflow_date = '2026-01-15'
     )`,
    [ERP_CUSTOMER_ID]
  );

  const res = await apiRequest("/api/debt-balances", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const row = res.data.rows.find((r) => r.customer_id === ERP_CUSTOMER_ID);
  assert.ok(row);
  assert.equal(String(row.last_payment_date).slice(0, 10), "2026-01-15");
});

test("GET /api/reports/customer-debt: multi-select sales_channel and aging params filter without errors", async () => {
  const res = await apiRequest("/api/reports/customer-debt?sales_channel=retail,wholesale&aging=15-30,30-60", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.customers));
  assert.ok(Array.isArray(res.data.by_bucket));
});

test("GET /api/customers/tin-lookup: a malformed TIN answers found:false without calling the registry", async () => {
  const res = await apiRequest("/api/customers/tin-lookup?tin=123", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { found: false, reason: "invalid_tin" });
});

test("GET /api/customers/:id/payments-received: Excel cashflow rows plus app payments; an app payment already in Excel is not listed twice", async () => {
  // App payments: one that matches the Excel 20000 row (same amount, 2 days apart) and one that doesn't.
  await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by)
     SELECT $1, 'x', a.amount, a.d::timestamptz, u.id, 'x', 'approved', u.id
     FROM (VALUES (20000, '2026-01-17'), (7777, '2026-03-05')) AS a(amount, d), (SELECT id FROM users LIMIT 1) u`,
    [customer.id]
  );
  try {
    const res = await apiRequest(`/api/customers/${customer.id}/payments-received`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    const bySource = (s) => res.data.rows.filter((r) => r.source === s);
    assert.equal(bySource("excel").length, 2);
    assert.deepEqual(bySource("app").map((r) => r.amount_amd), [7777], "the 20000 app payment duplicates the Excel row");
    assert.equal(res.data.rows[0].date, "2026-03-05", "newest first");
    assert.equal(res.data.total_amd, 20000 - 5000 + 7777);
  } finally {
    await pool.query("DELETE FROM payments WHERE customer_id = $1", [customer.id]);
  }
});

test("GET /api/reports/erp-payments: Excel cashflow rows with date/customer/channel filters and facets", async () => {
  const mine = (res) => res.data.rows.filter((r) => r.erp_customer_id === ERP_CUSTOMER_ID);
  const all = await apiRequest("/api/reports/erp-payments?period=all", { cookie: adminCookie });
  assert.equal(all.status, 200);
  assert.deepEqual(mine(all).map((r) => [r.date, Number(r.amount_amd)]), [["2026-02-20", -5000], ["2026-01-15", 20000]]);
  assert.equal(mine(all)[0].customer_name, customer.name);

  const ranged = await apiRequest("/api/reports/erp-payments?from=2026-01-01&to=2026-01-31", { cookie: adminCookie });
  assert.deepEqual(mine(ranged).map((r) => r.date), ["2026-01-15"]);

  const byId = await apiRequest(`/api/reports/erp-payments?period=all&q=${encodeURIComponent(ERP_CUSTOMER_ID)}`, { cookie: adminCookie });
  assert.equal(mine(byId).length, 2);
  assert.equal(byId.data.totals.payment_count, 2);
  assert.equal(Number(byId.data.totals.total_amd), 15000);

  const wrongChannel = await apiRequest("/api/reports/erp-payments?period=all&sales_channel=NoSuchChannel", { cookie: adminCookie });
  assert.equal(mine(wrongChannel).length, 0);
  const wrongRegion = await apiRequest("/api/reports/erp-payments?period=all&region_sub=Nowhere::__none__", { cookie: adminCookie });
  assert.equal(mine(wrongRegion).length, 0);
  assert.ok(Array.isArray(all.data.facets.sales_channels));

  // Sales managers have no access to this report by default.
  const manager = await createUser("sales_manager");
  const denied = await apiRequest("/api/reports/erp-payments", { cookie: await loginAs(manager.email) });
  assert.equal(denied.status, 403);
});
