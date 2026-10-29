// The server's copy of the Excel order lines (debtAging.js loadOrdersNewestFirst, migration 168): a long customer list is answered
// from the copy, and any change to the table (the daily sync's TRUNCATE + INSERT, an UPDATE, a DELETE) is seen by the next read.
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import { loadOrdersNewestFirst } from "../../src/money/debtAging.js";

const PREFIX = `OLC-${Date.now()}`;
const ids = Array.from({ length: 60 }, (_, i) => `${PREFIX}-${i}`);

test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id LIKE $1", [`${PREFIX}-%`]);
  await pool.end();
});

test("a long list reads the copy, and every change to the order lines shows on the next read", async () => {
  await pool.query(
    `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, qty, revenue_amd)
     SELECT id, 'A', DATE '2026-01-10', 'P', 1, 1000 FROM unnest($1::text[]) AS id`,
    [ids]
  );
  const first = await loadOrdersNewestFirst(pool, ids);
  assert.equal(first.size, 60);
  assert.deepEqual(first.get(ids[0]), [{ order_id: "A", date: "2026-01-10", total: 1000 }]);

  await pool.query("INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, qty, revenue_amd) VALUES ($1, 'B', DATE '2026-02-01', 'P', 1, 500)", [ids[0]]);
  assert.deepEqual((await loadOrdersNewestFirst(pool, ids)).get(ids[0]).map((o) => o.order_id), ["B", "A"], "a new order, newest first");

  await pool.query("UPDATE erp_order_lines SET revenue_amd = 700 WHERE erp_customer_id = $1 AND order_id = 'B'", [ids[0]]);
  assert.equal((await loadOrdersNewestFirst(pool, ids)).get(ids[0])[0].total, 700, "an update");
  // a single customer (a customer card) gets the same answer as the long list
  assert.equal((await loadOrdersNewestFirst(pool, [ids[0]])).get(ids[0])[0].total, 700);

  assert.deepEqual((await loadOrdersNewestFirst(pool, ids, { asOf: "2026-01-31" })).get(ids[0]).map((o) => o.order_id), ["A"], "up to a date");

  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [ids[1]]);
  assert.equal((await loadOrdersNewestFirst(pool, ids)).has(ids[1]), false, "a delete");
});
