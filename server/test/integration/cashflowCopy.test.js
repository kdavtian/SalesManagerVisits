// The server's copy of the Excel cashflow lines (money/cashflowCopy.js, migration 171): read once, and every change to the table
// (the daily sync's TRUNCATE + INSERT, an update, a delete) is seen by the next read.
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import { cashflowByCustomer, lastPayment } from "../../src/money/cashflowCopy.js";

const ID = `CFC-${Date.now()}`;
test.after(async () => {
  await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [ID]);
  await pool.end();
});

test("the copy follows every change; the last payment skips refunds and respects a date", async () => {
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, '2026-09-01', 5000), ($1, '2026-10-01', -700)", [ID]);
  assert.deepEqual(lastPayment((await cashflowByCustomer(pool)).get(ID)), { date: "2026-09-01", amount: 5000 }, "a refund is not a payment");
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, '2026-10-20', 9000)", [ID]);
  assert.equal(lastPayment((await cashflowByCustomer(pool)).get(ID)).amount, 9000, "an insert");
  assert.equal(lastPayment((await cashflowByCustomer(pool)).get(ID), "2026-10-10").date, "2026-09-01", "up to a date");
  await pool.query("UPDATE erp_cashflow_lines SET amount_amd = 9100 WHERE erp_customer_id = $1 AND amount_amd = 9000", [ID]);
  assert.equal(lastPayment((await cashflowByCustomer(pool)).get(ID)).amount, 9100, "an update");
  await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [ID]);
  assert.equal((await cashflowByCustomer(pool)).has(ID), false, "a delete");
});
