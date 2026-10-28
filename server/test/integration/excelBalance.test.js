// Previous debt on the signed blanks (owner, 2026-10-27): "Excel includes only ALREADY DELIVERED orders ... if the order is included,
// included, if no - no. Same for collected payments." The Excel debt plus the delivered app orders Excel does not show yet, minus the app
// payments Excel does not show yet; the app rows Excel does show are linked after the sync (erpAutoMatch.markAppRowsInExcel).
// Isolated (own database): it reads the newest Excel dates across the whole erp tables.
import test from "node:test";
import assert from "node:assert/strict";
import { cleanupAll, createUser, createCustomer } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { balanceBeforeVisit } from "../../src/signedActs.js";
import { markAppRowsInExcel } from "../../src/erpAutoMatch.js";

const ERP = `ITX${process.pid}`;
let rep;
let customer;
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test.before(async () => {
  rep = await createUser("sales_manager");
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: ERP });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, debt_amd) VALUES ($1, 100000)", [ERP]);
});
test.after(async () => {
  await pool.query("DELETE FROM payments WHERE customer_id = $1", [customer.id]);
  await pool.query("DELETE FROM order_status_history WHERE order_id IN (SELECT id FROM orders WHERE customer_id = $1)", [customer.id]);
  await pool.query("DELETE FROM orders WHERE customer_id = $1", [customer.id]);
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [ERP]);
  await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [ERP]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [ERP]);
  await cleanupAll();
  await pool.end();
});

async function deliveredOrder(total, daysBack = 0) {
  const at = new Date(Date.now() - daysBack * 86400000);
  const { rows } = await pool.query(
    "INSERT INTO orders (customer_id, user_id, status, total_amd, created_at, updated_at) VALUES ($1, $2, 'delivered', $3, $4, $4) RETURNING id",
    [customer.id, rep.id, total, at]
  );
  await pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1, 'confirmed', 'delivered', $2)", [rows[0].id, at]);
  return rows[0].id;
}
async function payment(amount, status = "approved", daysBack = 0) {
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by)
     VALUES ($1, 'X', $2, $3, $4, $5, 'R', $6, $5) RETURNING id`,
    [customer.id, ERP, amount, new Date(Date.now() - daysBack * 86400000), rep.id, status]
  );
  return rows[0].id;
}

test("Excel debt + delivered app orders not in Excel - app payments not in Excel; rows Excel holds are not counted twice", async () => {
  // Excel's newest records are today (so nothing recent is outside the window)
  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, $3, 40000)", [ERP, `${ERP}-A`, daysAgo(1)]);
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, $2, 15000)", [ERP, daysAgo(1)]);

  const inExcel = await deliveredOrder(40000, 1); // Excel has it (order A)
  const notYet = await deliveredOrder(25000, 0); // delivered today, not in Excel yet
  const paidInExcel = await payment(15000, "approved", 1); // Excel has it
  const paidNotYet = await payment(7000, "pending", 0); // collected today, not in Excel yet
  await payment(9000, "rejected", 0); // rejected: never counts

  const counts = await markAppRowsInExcel(pool);
  assert.deepEqual(counts, { orders: 1, payments: 1 });
  assert.equal((await pool.query("SELECT erp_matched_order_id FROM orders WHERE id = $1", [inExcel])).rows[0].erp_matched_order_id, `${ERP}-A`);
  assert.equal((await pool.query("SELECT status FROM orders WHERE id = $1", [inExcel])).rows[0].status, "delivered", "the status is untouched");
  assert.ok((await pool.query("SELECT erp_match_key FROM payments WHERE id = $1", [paidInExcel])).rows[0].erp_match_key);
  assert.equal((await pool.query("SELECT erp_match_key FROM payments WHERE id = $1", [paidNotYet])).rows[0].erp_match_key, null);

  // 100,000 (Excel) + 25,000 (order not in Excel) - 7,000 (payment not in Excel)
  assert.equal(await balanceBeforeVisit(pool, customer.id), 118000);
  // this visit's own order and payment are written on the blank separately, not in the previous debt
  assert.equal(await balanceBeforeVisit(pool, customer.id, { excludeOrderIds: [notYet], excludePaymentIds: [paidNotYet] }), 100000);
  // running the match again changes nothing
  assert.deepEqual(await markAppRowsInExcel(pool), { orders: 0, payments: 0 });
});

test("an unmatched app row older than two weeks before Excel's newest record is taken as already in Excel", async () => {
  await deliveredOrder(33333, 40); // a 40-day-old delivered order that never matched (different amount in Excel)
  await payment(4444, "approved", 40);
  assert.equal(await balanceBeforeVisit(pool, customer.id), 118000, "unchanged");
});

test("no Excel debt for the customer: no previous debt", async () => {
  const other = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: `${ERP}-none` });
  assert.equal(await balanceBeforeVisit(pool, other.id), null);
});
