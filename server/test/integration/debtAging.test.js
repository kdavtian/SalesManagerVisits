// Invoice-based debt aging in the reports: Customer debt (FIFO buckets, days past due), Debt balances
// (oldest due days per customer) and the Unpaid invoices report.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { allocateFifo, bucketOfDueDays } from "../../src/debtAging.js";

const stamp = Date.now();
const erpIds = [];
let admin, rep, adminCookie, repCookie, customer, erpId;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  erpId = `ITEST-AGE-${stamp}`;
  erpIds.push(erpId);
  customer = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: erpId, sales_channel: "retail", name: `Aging Garage ${stamp}` });
  await pool.query("UPDATE customers SET credit_term_days = 45 WHERE id = $1", [customer.id]);
  // Debt 800,000 = newest 300,000 (10 days ago, not due) + 350,000 (70 days: 25 past due) + 150,000 of the 400,000 order 200 days ago (155 past due).
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, synced_at) VALUES ($1, 'x', 800000, 0, now())", [erpId]);
  for (const [id, ago, total] of [["N1", 10, 300000], ["N2", 70, 350000], ["N3", 200, 400000]]) {
    await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Yerevan')::date - $3::int, $4)", [erpId, `${id}-${stamp}`, ago, total]);
  }
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [erpIds]);
  await cleanupAll();
  await stopTestServer();
});

test("allocateFifo: buckets by days past due, opening balance on its own", () => {
  const a = allocateFifo({
    orders: [{ order_id: "A", date: "2026-10-01", total: 100 }, { order_id: "B", date: "2026-07-01", total: 100 }],
    debt: 250, today: "2026-10-10", termDays: 45,
  });
  assert.equal(a.invoices[0].bucket, "not_due");
  assert.equal(a.invoices[1].due_days, 56); // 101 days old minus the 45-day term
  assert.equal(a.opening.unpaid, 50);
  assert.equal(a.buckets.opening, 50);
  assert.equal(bucketOfDueDays(0), "not_due");
  assert.equal(bucketOfDueDays(31), "d31_60");
  assert.equal(bucketOfDueDays(91), "d90_plus");
});

test("Customer debt report: FIFO buckets, due days and overdue amount per customer; the aging filter narrows the list", async () => {
  const res = await apiRequest("/api/reports/customer-debt", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const mine = res.data.customers.find((c) => c.erp_customer_id === erpId);
  assert.equal(mine.oldest_due_days, 200 - 45);
  assert.equal(mine.overdue_amd, 500000); // 350,000 + 150,000
  const buckets = Object.fromEntries(res.data.by_bucket.map((b) => [b.aging_bucket, b.total_debt_amd]));
  assert.ok(buckets.not_due >= 300000 && buckets.d1_30 >= 350000 && buckets.d90_plus >= 150000);
  const filtered = await apiRequest("/api/reports/customer-debt?aging=d90_plus", { cookie: adminCookie });
  assert.ok(filtered.data.customers.some((c) => c.erp_customer_id === erpId));
  assert.ok(filtered.data.customers.every((c) => c.oldest_due_days > 90 || c.opening_amd > 0));
});

test("Debt balances rows carry the oldest unpaid invoice's days past due", async () => {
  const res = await apiRequest("/api/debt-balances", { cookie: adminCookie });
  const mine = res.data.rows.find((r) => r.customer_id === erpId);
  assert.equal(mine.oldest_due_days, 155);
  assert.equal(mine.overdue_amd, 500000);
});

test("Unpaid invoices report: unpaid pieces oldest first, bucket filter, sales manager sees only their customers", async () => {
  const res = await apiRequest(`/api/biz-reports/unpaid-invoices?q=${encodeURIComponent(erpId)}`, { cookie: adminCookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.rows.map((r) => r.order_id.split("-")[0]), ["N3", "N2", "N1"]);
  assert.equal(res.data.rows[0].unpaid_amd, 150000);
  assert.equal(res.data.rows[0].due_days, 155);
  assert.equal(res.data.total_unpaid_amd, 800000);
  const only = await apiRequest(`/api/biz-reports/unpaid-invoices?q=${encodeURIComponent(erpId)}&bucket=not_due`, { cookie: adminCookie });
  assert.equal(only.data.rows.length, 1);
  const repView = await apiRequest(`/api/biz-reports/unpaid-invoices?q=${encodeURIComponent(erpId)}`, { cookie: repCookie });
  assert.equal(repView.data.rows.length, 3);
  const other = await createUser("sales_manager");
  const otherCookie = await loginAs(other.email);
  const otherView = await apiRequest(`/api/biz-reports/unpaid-invoices?q=${encodeURIComponent(erpId)}`, { cookie: otherCookie });
  assert.equal(otherView.data.rows.length, 0);
});
