// "From ERP": confirmed/packed orders that the workbook already shows become
// Delivered, pending cash payments that the workbook's payments already show
// become Approved (erpAutoMatch.js, run after every ERP sync). Calls the
// matchers directly with unique ERP customer ids so it never has to
// TRUNCATE the shared erp_* tables.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createCustomer, createUser, trackOrder, trackPayment } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { autoDeliverOrdersFromErp, autoApprovePaymentsFromErp, runAutoApprovePayments } from "../../src/erp/erpAutoMatch.js";

// The matchers work on Yerevan calendar dates; the database's CURRENT_DATE is
// UTC, which differs from 20:00 UTC to midnight -- use Yerevan's today.
const YEREVAN_TODAY = "(now() AT TIME ZONE 'Asia/Yerevan')::date";
const stamp = Date.now();
const erpIds = [];
test.before(startTestServer);
test.after(async () => {
  if (erpIds.length) {
    await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = ANY($1)", [erpIds]);
    await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = ANY($1)", [erpIds]);
  }
  await cleanupAll();
  await stopTestServer();
});

async function run(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } finally {
    client.release();
  }
}

async function customerWithErp(user, suffix) {
  const erp = `ITEST-AM-${suffix}-${stamp}`;
  erpIds.push(erp);
  return createCustomer({ created_by: user.id, erp_customer_id: erp });
}

async function addOrder(customerId, userId, status, total, code) {
  const { rows } = await pool.query(
    "INSERT INTO orders (customer_id, user_id, status, payment_method, total_amd, order_code) VALUES ($1, $2, $3, 'cash', $4, $5) RETURNING id",
    [customerId, userId, status, total, code]
  );
  return trackOrder(rows[0].id);
}

async function addPayment(customer, userId, amount, daysAgo) {
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, created_by)
     VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval, $6, 'Test', $6) RETURNING id`,
    [customer.id, customer.name, customer.erp_customer_id, amount, String(daysAgo), userId]
  );
  return trackPayment(rows[0].id);
}

test("order matching an ERP order (customer, date within a day, total) becomes Delivered from ERP; ambiguous ones are left alone", async () => {
  const rep = await createUser("sales_manager");
  const a = await customerWithErp(rep, "A");
  const orderA = await addOrder(a.id, rep.id, "confirmed", 52000, `T${stamp}-1`);
  const wrongTotal = await addOrder(a.id, rep.id, "confirmed", 11111, `T${stamp}-2`);
  // Same customer, same total, same day twice -> ambiguous, must not match.
  const b = await customerWithErp(rep, "B");
  const dup1 = await addOrder(b.id, rep.id, "packed_stock_out", 70000, `T${stamp}-3`);
  const dup2 = await addOrder(b.id, rep.id, "packed_stock_out", 70000, `T${stamp}-4`);
  const draft = await addOrder(a.id, rep.id, "draft", 52000, `T${stamp}-5`);
  const lines = [
    [a.erp_customer_id, `E${stamp}A`, 30000],
    [a.erp_customer_id, `E${stamp}A`, 22000],
    [b.erp_customer_id, `E${stamp}B`, 70000],
  ];
  for (const [cust, oid, rev] of lines) {
    await pool.query(`INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, revenue_amd) VALUES ($1, $2, ${YEREVAN_TODAY}, $3)`, [cust, oid, rev]);
  }
  const delivered = await run(autoDeliverOrdersFromErp);
  assert.ok(delivered.includes(orderA));
  assert.ok(!delivered.includes(wrongTotal) && !delivered.includes(dup1) && !delivered.includes(dup2) && !delivered.includes(draft));
  const o = (await pool.query("SELECT status, delivered_from_erp, erp_matched_order_id FROM orders WHERE id = $1", [orderA])).rows[0];
  assert.deepEqual(o, { status: "recorded", delivered_from_erp: true, erp_matched_order_id: `E${stamp}A` }, "found in the Excel: delivered and recorded (owner, 2026-11-11)");
  const hist = await pool.query("SELECT old_status, new_status, changed_by FROM order_status_history WHERE order_id = $1 ORDER BY id", [orderA]);
  assert.deepEqual(hist.rows, [{ old_status: "confirmed", new_status: "delivered", changed_by: null }, { old_status: "delivered", new_status: "recorded", changed_by: null }]);
  for (const id of [wrongTotal, dup1, dup2, draft]) {
    assert.notEqual((await pool.query("SELECT status FROM orders WHERE id = $1", [id])).rows[0].status, "delivered");
    assert.notEqual((await pool.query("SELECT status FROM orders WHERE id = $1", [id])).rows[0].status, "recorded");
  }
  // Running again changes nothing (the ERP order is used up).
  assert.deepEqual(await run(autoDeliverOrdersFromErp), []);
});

test("pending payment matching an ERP payment (customer, exact amount, date within 3 days) becomes Approved from ERP, once per ERP row", async () => {
  const rep = await createUser("sales_manager");
  const c = await customerWithErp(rep, "C");
  const match = await addPayment(c, rep.id, 150000, 1);
  const twin = await addPayment(c, rep.id, 150000, 2); // same amount, only one ERP row -> only one approved
  const farAway = await addPayment(c, rep.id, 80000, 9); // ERP row is 9 days away
  const noErp = await addPayment(c, rep.id, 99999, 0);
  await pool.query(`INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, ${YEREVAN_TODAY} - 1, 150000)`, [c.erp_customer_id]);
  await pool.query(`INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, ${YEREVAN_TODAY}, 80000)`, [c.erp_customer_id]);
  const approved = await run(autoApprovePaymentsFromErp);
  assert.deepEqual(approved, [match]); // closest date wins, twin stays pending
  const row = (await pool.query("SELECT status, approved_from_erp, approved_by, erp_match_key FROM payments WHERE id = $1", [match])).rows[0];
  assert.equal(row.status, "approved");
  assert.equal(row.approved_from_erp, true);
  assert.equal(row.approved_by, null);
  assert.ok(row.erp_match_key.startsWith(c.erp_customer_id));
  for (const id of [twin, farAway, noErp]) {
    assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [id])).rows[0].status, "pending");
  }
  assert.deepEqual(await run(autoApprovePaymentsFromErp), []); // the ERP row is used up, twin does not take it
  const hist = await pool.query("SELECT old_status, new_status FROM payment_status_history WHERE payment_id = $1", [match]);
  assert.deepEqual(hist.rows, [{ old_status: "pending", new_status: "approved" }]);
});

// Owner, 2026-11-14 (screenshot: payments with the green "In Excel" chip still waiting for approval): what the chip calls "in Excel" is
// approved by the sync.
test("a payment the Excel shows is approved even while it is inside a handover, and even when the sync linked it earlier; the window is the chip's", async () => {
  const rep = await createUser("sales_manager");
  const director = await createUser("sales_director");
  const c = await customerWithErp(rep, "H");
  // (1) inside a handover waiting for the director
  const inHandoff = await addPayment(c, rep.id, 45000, 1);
  const { rows: [h] } = await pool.query("INSERT INTO cash_handoffs (from_user_id, to_user_id, amount_amd, status, submitted_by) VALUES ($1, $2, 45000, 'pending', $1) RETURNING id", [rep.id, director.id]);
  await pool.query("INSERT INTO cash_handoff_items (handoff_id, payment_id) VALUES ($1, $2)", [h.id, inHandoff]);
  await pool.query("UPDATE payments SET pending_handoff_id = $1, current_holder_id = $2 WHERE id = $3", [h.id, rep.id, inHandoff]);
  await pool.query(`INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, ${YEREVAN_TODAY} - 1, 45000)`, [c.erp_customer_id]);
  // (2) already linked to its Excel row by an earlier sync (markAppRowsInExcel), still pending: it used to block itself forever
  const linked = await addPayment(c, rep.id, 61000, 2);
  await pool.query(`INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, ${YEREVAN_TODAY} - 2, 61000)`, [c.erp_customer_id]);
  const { rows: [k] } = await pool.query(`SELECT $1 || '|' || (${YEREVAN_TODAY} - 2)::text || '|' || '61000' AS key`, [c.erp_customer_id]);
  await pool.query("UPDATE payments SET erp_match_key = $2 WHERE id = $1", [linked, k.key]);
  // (3) 4 days between the app and the Excel (the chip says "in Excel" up to 5)
  const fourDays = await addPayment(c, rep.id, 33000, 5);
  await pool.query(`INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, ${YEREVAN_TODAY} - 1, 33000)`, [c.erp_customer_id]);

  const approved = await run(autoApprovePaymentsFromErp);
  assert.deepEqual([...approved].sort((a, b) => a - b), [inHandoff, linked, fourDays].sort((a, b) => a - b));
  const rows = (await pool.query("SELECT id, status, approved_from_erp, approved_by, pending_handoff_id, current_holder_id FROM payments WHERE id = ANY($1)", [[inHandoff, linked, fourDays]])).rows;
  for (const r of rows) {
    assert.equal(r.status, "approved");
    assert.equal(r.approved_from_erp, true);
    assert.equal(r.approved_by, null, "nobody received the notes yet: the cash is still in hand");
  }
  // the handover still carries the payment, the rep still holds it until the director confirms
  const ho = rows.find((r) => r.id === inHandoff);
  assert.equal(ho.pending_handoff_id, h.id);
  assert.equal(ho.current_holder_id, rep.id);
  // nothing twice
  assert.deepEqual(await run(autoApprovePaymentsFromErp), []);
  await pool.query("UPDATE payments SET pending_handoff_id = NULL WHERE id = $1", [inHandoff]);
  await pool.query("DELETE FROM cash_handoff_items WHERE handoff_id = $1", [h.id]);
  await pool.query("DELETE FROM cash_handoffs WHERE id = $1", [h.id]);
});

// Review 2026-11-14 of the change above
test("a payment a person sent back to Pending is never approved again by the sync; a link to a row no longer in the Excel is re-matched", async () => {
  const rep = await createUser("sales_manager");
  const c = await customerWithErp(rep, "R");
  const sentBack = await addPayment(c, rep.id, 52000, 1);
  await pool.query(`INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, ${YEREVAN_TODAY} - 1, 52000)`, [c.erp_customer_id]);
  assert.deepEqual(await run(autoApprovePaymentsFromErp), [sentBack]);
  // the accountant: "wrong Excel row" -> back to pending (the route keeps the link, as before)
  await pool.query("UPDATE payments SET status = 'pending', approved_at = NULL, approved_from_erp = false WHERE id = $1", [sentBack]);
  await pool.query("INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by) VALUES ($1, 'approved', 'pending', 'wrong row', $2)", [sentBack, rep.id]);
  assert.deepEqual(await run(autoApprovePaymentsFromErp), [], "the reversal sticks");
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [sentBack])).rows[0].status, "pending");

  // linked to a row the accountant then corrected in the workbook (another date): the link is dropped and the corrected row matches
  const stale = await addPayment(c, rep.id, 27000, 2);
  await pool.query("UPDATE payments SET erp_match_key = $2 WHERE id = $1", [stale, `${c.erp_customer_id}|2000-01-01|27000`]);
  await pool.query(`INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, ${YEREVAN_TODAY} - 2, 27000)`, [c.erp_customer_id]);
  assert.deepEqual(await run(autoApprovePaymentsFromErp), [stale]);
});

test("4-5 days apart only when the pairing is unique: two app payments of the same amount around one Excel row are left to the accountant", async () => {
  const rep = await createUser("sales_manager");
  const c = await customerWithErp(rep, "U");
  const a = await addPayment(c, rep.id, 18000, 9);
  const b = await addPayment(c, rep.id, 18000, 1);
  // the Excel row is 4 days from each of them
  await pool.query(`INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, ${YEREVAN_TODAY} - 5, 18000)`, [c.erp_customer_id]);
  assert.deepEqual(await run(autoApprovePaymentsFromErp), []);
  for (const id of [a, b]) assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [id])).rows[0].status, "pending");
});

test("the background job approves a payment the Excel already shows, without waiting for the next upload", async () => {
  const rep = await createUser("sales_manager");
  const c = await customerWithErp(rep, "J");
  const p = await addPayment(c, rep.id, 41000, 1);
  await pool.query(`INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, ${YEREVAN_TODAY} - 1, 41000)`, [c.erp_customer_id]);
  const out = await runAutoApprovePayments();
  assert.ok(out.approved >= 1);
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [p])).rows[0].status, "approved");
});
