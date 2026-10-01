// Debt-as-of-date: GET /api/reports/customer-debt and GET /api/debt-balances
// with a ?date= param. reports.js's /customer-debt still computes an
// absolute running balance from full order/cashflow history (see its own
// tests below); debtBalances.js's /debt-balances instead anchors on the
// live erp_customer_data.debt_amd snapshot and only looks at what's
// changed *since* the as-of date (see server/src/routes/debtBalances.js's
// own comment on asOfBalanceJoin for why -- an absolute sum over possibly-
// incomplete all-time cashflow history was reported live as wildly
// overstating historical debt).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const ERP_CUSTOMER_ID = `itest-debt-asof-${Date.now()}`;

let adminCookie;
let customer;

test.before(async () => {
  await startTestServer();
  const admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
  customer = await createCustomer({ created_by: admin.id, erp_customer_id: ERP_CUSTOMER_ID });

  await pool.query(
    `INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at)
     VALUES ($1, 'Itest Debt Customer', 100000, now())`,
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

test("GET /api/reports/customer-debt?date=: computes a running balance from order/cashflow history, ignoring later entries", async () => {
  // As of 2026-01-20: 50000 order (Jan 10) - 20000 payment (Jan 15) = 30000.
  // The Feb order and Feb refund are both after this date and excluded.
  const res = await apiRequest("/api/reports/customer-debt?date=2026-01-20", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.as_of_date, "2026-01-20");
  const row = res.data.customers.find((c) => c.erp_customer_id === ERP_CUSTOMER_ID);
  assert.equal(Number(row.estimated_debt_amd), 30000);
});

test("GET /api/reports/customer-debt?date=: a refund after the debt-clearing point nets back into the balance", async () => {
  // As of 2026-02-28 (everything included): (50000+30000) - (20000-5000) = 65000.
  const res = await apiRequest("/api/reports/customer-debt?date=2026-02-28", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const row = res.data.customers.find((c) => c.erp_customer_id === ERP_CUSTOMER_ID);
  assert.equal(Number(row.estimated_debt_amd), 65000);
});

test("GET /api/debt-balances?date=: anchors on the live debt and backs out what happened after the as-of date", async () => {
  // live debt_amd = 100000. After 2026-01-20: the 30000 order (Feb 10) and
  // the -5000 refund (Feb 20) both happened later, so back them out of
  // today's live figure: 100000 - 30000 - (-5000) = 65000.
  const res = await apiRequest("/api/debt-balances?date=2026-01-20", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.as_of_date, "2026-01-20");
  const row = res.data.rows.find((r) => r.customer_id === ERP_CUSTOMER_ID);
  assert.equal(Number(row.remaining_balance), 65000);
});

test("GET /api/debt-balances?date=: a date with nothing after it returns exactly the live figure", async () => {
  // Nothing in this customer's history falls after 2026-03-01 (last entry
  // is the Feb 20 refund), so the as-of balance must equal live debt_amd
  // exactly -- this is the property that closes the originally-reported
  // bug: picking today as the as-of date must never diverge from "Live".
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
// thinner cashflow history (confirmed by the reporting user: picking
// today as the as-of date came back many times larger than Live for the
// same customer), the old absolute SUM(orders)-SUM(cashflow) formula
// summed ~all 10,000,000 AMD of orders ever placed against only the
// 100,000 AMD of cashflow the sync happened to carry, wildly overstating
// debt. The anchored formula must ignore that incomplete ancient history
// entirely once nothing falls after the as-of date, and return exactly
// the trusted live figure.
const THIN_CASHFLOW_ERP_ID = `itest-debt-asof-thincashflow-${Date.now()}`;

test("GET /api/debt-balances?date=: a customer with thin cashflow history relative to orders is not inflated -- matches live when nothing falls after the as-of date", async () => {
  const admin = await createUser("admin");
  await createCustomer({ created_by: admin.id, erp_customer_id: THIN_CASHFLOW_ERP_ID });
  await pool.query(
    `INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at)
     VALUES ($1, 'Itest Thin Cashflow Customer', 50000, now())`,
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

    // As of a date after all of the above (nothing to back out): the old
    // formula would have returned 10,000,000 - 100,000 = 9,900,000. The
    // anchored formula must return exactly the live 50,000.
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
