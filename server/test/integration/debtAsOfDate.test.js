// Debt-as-of-date: GET /api/reports/customer-debt and GET /api/debt-balances
// with a ?date= param, computed from full order/cashflow history
// (erp_order_lines / erp_cashflow_lines) as a running balance rather than
// the live erp_customer_data.debt_amd snapshot -- see
// docs/erp-sync-contract.md's cashflow_lines entry.
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
     VALUES ($1, 'Itest Debt Customer', 999999, now())`,
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
  assert.equal(Number(row.debt_amd), 999999);
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

test("GET /api/debt-balances?date=: same running-balance math as the customer-debt report", async () => {
  const res = await apiRequest("/api/debt-balances?date=2026-01-20", { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.equal(res.data.as_of_date, "2026-01-20");
  const row = res.data.rows.find((r) => r.customer_id === ERP_CUSTOMER_ID);
  assert.equal(Number(row.remaining_balance), 30000);
});

test("GET /api/debt-balances: without ?date= still uses the live snapshot", async () => {
  const res = await apiRequest("/api/debt-balances", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const row = res.data.rows.find((r) => r.customer_id === ERP_CUSTOMER_ID);
  assert.equal(Number(row.remaining_balance), 999999);
});
