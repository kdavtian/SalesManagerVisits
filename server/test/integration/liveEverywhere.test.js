// Release 5 (owner, 2026-11-03: "yes" to the live debt everywhere): the desktop Home figures, the weekly debt digest, the Customer debt
// and Unpaid invoices reports and Vaghinak's debt tasks read the LIVE debt (Excel + app orders it does not have yet - app / bank
// payments it does not have yet), so a customer who paid in the app is not chased and an app order not in Excel yet is owed.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackOrder, trackPayment } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { buildDebtSnapshot } from "../../src/money/debtDigest.js";
import { computeKpis } from "../../src/reports/dashboardKpis.js";
import { createDebtCollectionTasks, autoTaskDiagnostics } from "../../src/money/debtCollectionTasks.js";
import { liveDebtors } from "../../src/money/liveDebt.js";
import { yerevanToday } from "../../src/utils/yerevanDate.js";

const stamp = Date.now().toString(36);
const erp = { paid: `ILE-P-${stamp}`, app: `ILE-A-${stamp}`, owes: `ILE-O-${stamp}` };
let admin, rep, cookie, paid, appOnly, owes, bankAccount;

async function excelDebtor(erpId, debt, { orderDaysAgo = null } = {}) {
  const c = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: erpId });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, days_since_payment, synced_at) VALUES ($1, 'x', $2, $3, now())", [erpId, debt, orderDaysAgo]);
  if (orderDaysAgo != null) {
    await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, CURRENT_DATE - $3::int, $4)", [erpId, `${erpId}-1`, orderDaysAgo, debt]);
  }
  return c;
}

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  cookie = await loginAs(admin.email);
  // 1) owes 100,000 in the Excel, 120 days late, but the rep collected all of it in the app (not in the Excel yet)
  paid = await excelDebtor(erp.paid, 100000, { orderDaysAgo: 120 });
  trackPayment(
    (await pool.query(
      `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
       VALUES ($1, 'x', 100000, now(), $2, 'Rep', 'pending', $2, $2) RETURNING id`,
      [paid.id, rep.id]
    )).rows[0].id
  );
  // 2) nothing in the Excel, a delivered app order of 30,000 the Excel does not have yet
  appOnly = await excelDebtor(erp.app, 0);
  trackOrder((await pool.query("INSERT INTO orders (customer_id, user_id, status, total_amd, order_code) VALUES ($1, $2, 'delivered', 30000, $3) RETURNING id", [appOnly.id, rep.id, `LE-${stamp}`])).rows[0].id);
  // 3) owes 200,000, 120 days late, nothing paid
  owes = await excelDebtor(erp.owes, 200000, { orderDaysAgo: 120 });
  bankAccount = (await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'bank') RETURNING id", [`ILE bank ${stamp}`])).rows[0].id;
});
test.after(async () => {
  const ids = [paid.id, appOnly.id, owes.id];
  await pool.query("DELETE FROM tasks WHERE customer_id = ANY($1)", [ids]);
  await pool.query("DELETE FROM customer_payments WHERE customer_id = ANY($1)", [ids]);
  await pool.query("DELETE FROM cash_accounts WHERE id = $1", [bankAccount]);
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = ANY($1)", [Object.values(erp)]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [Object.values(erp)]);
  await cleanupAll();
  await stopTestServer();
});

test("liveDebtors: paid in the app is gone, the app-only order is owed, the late debt stays late", async () => {
  const rows = await liveDebtors(pool, { today: yerevanToday() });
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.ok(!byId.has(paid.id), "paid in the app: not a debtor");
  assert.equal(byId.get(appOnly.id)?.live.debt_amd, 30000);
  assert.equal(byId.get(owes.id)?.live.debt_amd, 200000);
  assert.equal(byId.get(owes.id)?.live.aging.overdue_amd, 200000);
});

test("the weekly debt digest and the desktop Home figures count the live debt", async () => {
  const snap = await buildDebtSnapshot(pool, yerevanToday());
  assert.equal(snap.customers[paid.id], undefined);
  assert.equal(snap.customers[appOnly.id]?.debt, 30000);
  assert.equal(snap.customers[owes.id]?.overdue, 200000);
  const kpis = await computeKpis();
  assert.ok(kpis.debt.total_amd >= 230000);
  assert.ok(kpis.debt.overdue_amd >= 200000);
});

test("Customer debt and Unpaid invoices: the live figure with the gap; the app order is an unpaid invoice", async () => {
  const report = await apiRequest("/api/reports/customer-debt?debt_only=1", { cookie });
  assert.equal(report.status, 200);
  const row = (id) => report.data.customers.find((c) => c.erp_customer_id === id);
  assert.equal(row(erp.paid), undefined, "paid in the app: not in the debt-only list");
  assert.equal(Number(row(erp.app).estimated_debt_amd), 30000);
  assert.equal(row(erp.app).not_in_excel_orders_amd, 30000);
  assert.equal(Number(row(erp.owes).estimated_debt_amd), 200000);
  const all = await apiRequest("/api/reports/customer-debt", { cookie });
  const p = all.data.customers.find((c) => c.erp_customer_id === erp.paid);
  assert.equal(Number(p.estimated_debt_amd), 0);
  assert.equal(Number(p.debt_amd), 100000, "the Excel figure is still there");
  assert.equal(p.collected_since_sync_amd, 100000);
  const unpaid = await apiRequest("/api/biz-reports/unpaid-invoices", { cookie });
  assert.equal(unpaid.status, 200, JSON.stringify(unpaid.data));
  assert.ok(unpaid.data.rows.some((r) => r.customer_id === appOnly.id && r.order_id === `LE-${stamp}` && r.unpaid_amd === 30000 && r.in_app));
  assert.ok(!unpaid.data.rows.some((r) => r.customer_id === paid.id));
  // Debt balances lists the customer at zero in the Excel who owes for an app order
  const balances = await apiRequest("/api/debt-balances", { cookie });
  const b = balances.data.rows.find((x) => x.internal_customer_id === appOnly.id);
  assert.equal(Number(b?.remaining_balance), 30000);
  assert.equal(Number(b?.excel_balance), 0);
});

test("Vaghinak's debt tasks: nobody chases a customer who paid in the app; a bank payment closes the task of one who owes", async () => {
  await createDebtCollectionTasks(new Date(), { notify: false });
  const tasks = async (id) => (await pool.query("SELECT id, status, outcome, title FROM tasks WHERE customer_id = $1 AND auto_kind = 'debt_collection'", [id])).rows;
  assert.equal((await tasks(paid.id)).length, 0, "paid in the app");
  const [open] = await tasks(owes.id);
  assert.equal(open?.status, "open");
  assert.match(open.title, /200,000/);
  const diag = await autoTaskDiagnostics();
  assert.ok(diag.paid_in_app >= 1);
  // the accountant records the bank transfer in Bank & cash desks: the task closes as paid
  const r = await apiRequest("/api/payments2/bank/payments", {
    method: "POST",
    cookie,
    body: { customer_id: owes.id, amount: 200000, day: yerevanToday(), account_id: bankAccount, method: "bank", client_ref: `ile-${stamp}` },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  let closed;
  for (let i = 0; i < 40 && closed?.status !== "done"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    [closed] = await tasks(owes.id);
  }
  assert.equal(closed.status, "done");
  assert.equal(closed.outcome, "paid");
});
