// Debt balances: "collected in the app but not yet in the Excel (ERP)". An app payment (pending/approved) of the last
// 60 days with no matching Excel cashflow line (same amount, within 5 days, one line per payment) is listed per customer
// and totalled; a payment the Excel already shows -- or the sync already settled ("From ERP") -- is not.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

const stamp = Date.now();
let admin, rep, other, adminCookie, repCookie, otherCookie, customer, erpId;

async function addPayment({ amount, daysAgo, status = "approved", user = rep, fromErp = false }) {
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, approved_from_erp)
     VALUES ($1, 'x', $2, $3, now() - ($4 || ' days')::interval, $5, 'x', $6, $5, $7) RETURNING id`,
    [customer.id, erpId, amount, daysAgo, user.id, status, fromErp]
  );
  return rows[0].id;
}

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  other = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  otherCookie = await loginAs(other.email);
  erpId = `ITEST-UNREC-${stamp}`;
  customer = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: erpId, sales_channel: "retail", name: `Unrecorded Garage ${stamp}` });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, balance0_amd, synced_at) VALUES ($1, 'x', 900000, 0, now())", [erpId]);
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, (now() AT TIME ZONE 'Asia/Yerevan')::date - 100, 900000)", [erpId, `U1-${stamp}`]);
});
test.after(async () => {
  await pool.query("DELETE FROM payments WHERE customer_id = $1", [customer.id]);
  await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [erpId]);
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [erpId]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [erpId]);
  await cleanupAll();
  await stopTestServer();
});

const rowOf = async (cookie, query = "") => (await apiRequest(`/api/debt-balances${query}`, { cookie })).data.rows.find((r) => r.customer_id === erpId);

test("overdue amount rides along, and payments with no Excel line are summed as 'not yet in the Excel'", async () => {
  await addPayment({ amount: 200000, daysAgo: 1 }); // nothing in the Excel
  await addPayment({ amount: 50000, daysAgo: 2, status: "pending" }); // pending counts too
  await addPayment({ amount: 120000, daysAgo: 3 }); // the Excel has it -> recorded
  await addPayment({ amount: 70000, daysAgo: 4, fromErp: true }); // settled by the ERP sync -> recorded
  await addPayment({ amount: 33000, daysAgo: 90 }); // older than the window
  await addPayment({ amount: 10000, daysAgo: 1, status: "rejected" }); // rejected never counts
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, (now() AT TIME ZONE 'Asia/Yerevan')::date - 4, 120000)", [erpId]);

  const row = await rowOf(adminCookie);
  assert.ok(row, "customer listed");
  assert.equal(Number(row.overdue_amd), 900000, "the whole 100-day-old invoice is past its 45-day term");
  assert.equal(Number(row.unrecorded_amd), 250000);
  assert.equal(row.unrecorded_count, 2);
});

test("one Excel line settles only one app payment of the same amount", async () => {
  await addPayment({ amount: 120000, daysAgo: 2 }); // second payment of 120,000, only one Excel line exists
  const row = await rowOf(adminCookie);
  assert.equal(Number(row.unrecorded_amd), 250000 + 120000);
  assert.equal(row.unrecorded_count, 3);
});

test("a sales manager counts only their own collections; a past date has no 'not yet' amount", async () => {
  await addPayment({ amount: 15000, daysAgo: 1, user: other });
  const mine = await rowOf(repCookie);
  assert.equal(Number(mine.unrecorded_amd), 370000, "the other rep's 15,000 is not mine");
  const all = await rowOf(adminCookie);
  assert.equal(Number(all.unrecorded_amd), 385000);
  const asOf = await rowOf(adminCookie, `?date=${new Date().toISOString().slice(0, 10)}`);
  assert.equal(Number(asOf.unrecorded_amd), 0);
  assert.equal(await rowOf(otherCookie), undefined, "not their customer");
});
