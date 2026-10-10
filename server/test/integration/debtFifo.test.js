// Payments clear the oldest invoices first (FIFO): the orders that are still unpaid, their days
// past due (credit term deducted), the opening balance and the debt summary on the customer card.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const stamp = Date.now();
const erpIds = [];
let admin;
let cookie;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  cookie = await loginAs(admin.email);
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = ANY($1)", [erpIds]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = ANY($1)", [erpIds]);
  await cleanupAll();
  await stopTestServer();
});

async function customerWithDebt(suffix, { debt, balance0, term = 45, orders }) {
  const erpId = `ITEST-FIFO-${suffix}-${stamp}`;
  erpIds.push(erpId);
  const customer = await createCustomer({ created_by: admin.id, erp_customer_id: erpId, sales_channel: "retail" });
  await pool.query("UPDATE customers SET credit_term_days = $2 WHERE id = $1", [customer.id, term]);
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, synced_at) VALUES ($1, 'x', $2, $3, now())", [erpId, debt, balance0]);
  for (const [orderId, daysAgo, total] of orders) {
    await pool.query(
      "INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Yerevan')::date - $3::int, $4)",
      [erpId, `${orderId}-${stamp}`, daysAgo, total]
    );
  }
  return { customer, erpId };
}

test("the newest orders make up the debt: older ones are paid (FIFO), due days deduct the credit term", async () => {
  const { customer } = await customerWithDebt("a", { debt: 700000, balance0: 100000, orders: [["A", 100, 200000], ["B", 60, 300000], ["C", 10, 400000]] });
  const res = await apiRequest(`/api/customers/${customer.id}/erp-orders?scope=all`, { cookie });
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.data.map((r) => [r.order_id.split("-")[0], r]));
  assert.equal(byId.C.unpaid_amd, 400000);
  assert.equal(byId.C.due_days, -35); // 10 days old, 45-day term: due in 35 days
  assert.equal(byId.B.unpaid_amd, 300000);
  assert.equal(byId.B.due_days, 15); // 60 days old: 15 days past due
  assert.equal(byId.A.unpaid_amd, 0);
  assert.equal(byId.A.due_days, null);

  const card = await apiRequest(`/api/customers/${customer.id}`, { cookie });
  assert.equal(card.data.erp_balance0_amd, 100000);
  assert.equal(card.data.debt_summary.oldest_due_days, 15);
  assert.equal(card.data.debt_summary.overdue_amd, 300000);
  assert.equal(card.data.debt_summary.opening_unpaid_amd, 0);
});

test("a debt bigger than all the orders is the opening balance (the oldest debt of all); a partly paid order shows its unpaid part", async () => {
  const { customer } = await customerWithDebt("b", { debt: 1000000, balance0: 250000, orders: [["D", 80, 300000], ["E", 20, 450000]] });
  const res = await apiRequest(`/api/customers/${customer.id}/erp-orders?scope=all`, { cookie });
  assert.equal(res.data.find((r) => r.order_id.startsWith("E")).unpaid_amd, 450000);
  assert.equal(res.data.find((r) => r.order_id.startsWith("D")).unpaid_amd, 300000);
  const card = await apiRequest(`/api/customers/${customer.id}`, { cookie });
  assert.equal(card.data.debt_summary.opening_unpaid_amd, 250000);
  // The opening balance is dated 2025-05-01, so it is long past due.
  assert.ok(card.data.debt_summary.oldest_due_days > 300);
  assert.equal(card.data.debt_summary.overdue_amd, 1000000 - 450000 + 0); // everything except the 20-day-old order

  const part = await customerWithDebt("c", { debt: 500000, balance0: 0, orders: [["F", 90, 300000], ["G", 30, 350000]] });
  const partRes = await apiRequest(`/api/customers/${part.customer.id}/erp-orders?scope=all`, { cookie });
  assert.equal(partRes.data.find((r) => r.order_id.startsWith("G")).unpaid_amd, 350000);
  assert.equal(partRes.data.find((r) => r.order_id.startsWith("F")).unpaid_amd, 150000, "only the newer part of F is still owed");
});

test("a credit (negative opening balance) and a paid-up customer have no unpaid orders", async () => {
  const credit = await customerWithDebt("d", { debt: 0, balance0: -120000, orders: [["H", 50, 200000]] });
  const res = await apiRequest(`/api/customers/${credit.customer.id}/erp-orders?scope=all`, { cookie });
  assert.equal(res.data[0].unpaid_amd, 0);
  const card = await apiRequest(`/api/customers/${credit.customer.id}`, { cookie });
  assert.equal(card.data.erp_balance0_amd, -120000);
  assert.equal(card.data.debt_summary.oldest_due_days, null);
});

test("the Sales page marks the unpaid orders with their due days", async () => {
  const { erpId } = await customerWithDebt("e", { debt: 300000, balance0: 0, term: 30, orders: [["I", 50, 300000], ["J", 5, 100000]] });
  const from = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const res = await apiRequest(`/api/sales?from=${from}&to=2999-01-01&q=${encodeURIComponent(erpId)}`, { cookie });
  assert.equal(res.status, 200);
  const byId = Object.fromEntries(res.data.rows.map((r) => [r.order_id.split("-")[0], r]));
  assert.equal(byId.J.unpaid_amd, 100000);
  assert.equal(byId.J.due_days, -25);
  assert.equal(byId.I.unpaid_amd, 200000, "the 300,000 debt = J 100,000 + the newer 200,000 of I");
  assert.equal(byId.I.due_days, 20);
});
