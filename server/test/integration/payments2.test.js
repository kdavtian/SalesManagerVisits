// Payments, redesigned -- release 1 (server only): the copy from the old module, the books track against the Excel Cash rows (stable across
// refreshes, sums accepted, rows that disappear undo the booking), voiding rules, and who may read the status. Owner, 2026-11-02.
// Isolated (test/isolated-tests.txt): the copy and the matching act on every payment since the cutover.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { runBridge } from "../../src/money/payments2/bridge.js";
import { runBooks } from "../../src/money/payments2/books.js";

let users, cookies, shop, shopNoErp, account, category;
const today = new Date().toISOString().slice(0, 10);
const ERP = `ITP2${Date.now().toString(36)}`;

async function oldPayment(amount, { customer = shop, holder = users.rep, status = "pending" } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot,
       status, created_by, current_holder_id)
     VALUES ($1, $2, $3, $4, now(), $5, 'Rep', $6, $5, $7) RETURNING id`,
    [customer.id, customer.name, customer.erp_customer_id ?? null, amount, users.rep.id, status, holder.id]
  );
  return rows[0].id;
}
const copyOf = async (legacyId) => (await pool.query("SELECT * FROM customer_payments WHERE legacy_payment_id = $1", [legacyId])).rows[0];
const excelRow = (amount, row, day = today) =>
  pool.query(
    "INSERT INTO cash_entries (entry_date, amount, amount_amd, category_id, account_id, erp_customer_id, origin, excel_row) VALUES ($1, $2, $2, $3, $4, $5, 'excel', $6)",
    [day, amount, category, account, ERP, row]
  );

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "accountant", "sales_manager", "sales_director"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
  users.rep = users.sales_manager;
  shop = await createCustomer({ created_by: users.rep.id });
  await pool.query("UPDATE customers SET erp_customer_id = $2 WHERE id = $1", [shop.id, ERP]);
  shop.erp_customer_id = ERP;
  shopNoErp = await createCustomer({ created_by: users.rep.id });
  await pool.query("UPDATE app_settings SET payments_cutover = $1::date - 10 WHERE id = 1", [today]);
  account = (await pool.query("INSERT INTO cash_accounts (name, kind, holder_user_id) VALUES ($1, 'cash', $2) RETURNING id", [`Cash ${ERP}`, users.rep.id])).rows[0].id;
  category = (await pool.query("SELECT id FROM cash_categories WHERE name = 'Oil order'")).rows[0].id;
});

test.after(async () => {
  await pool.query("DELETE FROM customer_payments WHERE customer_id = ANY($1)", [[shop.id, shopNoErp.id]]);
  await pool.query("DELETE FROM payments WHERE customer_id = ANY($1)", [[shop.id, shopNoErp.id]]);
  await pool.query("DELETE FROM cash_entries WHERE erp_customer_id = $1", [ERP]);
  await pool.query("DELETE FROM cash_accounts WHERE id = $1", [account]);
  await cleanupAll();
  await stopTestServer();
});

test("the copy brings the old module's payments since the cutover, with the cash track and the rep's cash desk", async () => {
  const id = await oldPayment(50000);
  await runBridge();
  const copy = await copyOf(id);
  assert.equal(Number(copy.amount_amd), 50000);
  assert.equal(copy.method, "cash");
  assert.equal(copy.cash_state, "collected");
  assert.equal(copy.account_id, account);
  assert.equal(copy.source, "bridge");
  // the director now holds it in the old module: counted here
  await pool.query("UPDATE payments SET current_holder_id = $2 WHERE id = $1", [id, users.sales_director.id]);
  await runBridge();
  assert.equal((await copyOf(id)).cash_state, "counted");
});

test("books: the Excel row books it with its reason, survives a refresh of the sheet, and an Excel row that disappears reopens it", async () => {
  const id = await oldPayment(73000);
  await runBridge();
  await excelRow(73000, 501);
  await runBooks();
  let copy = await copyOf(id);
  assert.equal(copy.books_state, "matched");
  assert.match(copy.books_note, /73,000 AMD · Cash ITP2.* · row 501/);
  // the sheet is refreshed: rows deleted and loaded again (new ids), same content
  await pool.query("DELETE FROM cash_entries WHERE erp_customer_id = $1 AND excel_row = 501", [ERP]);
  await excelRow(73000, 501);
  await runBooks();
  assert.equal((await copyOf(id)).books_state, "matched");
  // an empty sheet (half loaded) undoes nothing
  await pool.query("DELETE FROM cash_entries WHERE erp_customer_id = $1 AND excel_row = 501", [ERP]);
  const others = await pool.query("SELECT count(*)::int AS n FROM cash_entries WHERE amount_amd > 0 AND erp_customer_id IS NOT NULL");
  if (others.rows[0].n === 0) {
    await runBooks();
    assert.equal((await copyOf(id)).books_state, "matched");
  }
  // the row is gone from a sheet that has other rows
  await excelRow(88000, 503);
  await runBooks();
  copy = await copyOf(id);
  assert.equal(copy.books_state, "open");
  assert.match(copy.books_note, /no longer in the sheet/);
});

test("books: two payments booked as one Excel row are matched together; a customer without an ERP id says so", async () => {
  const a = await oldPayment(21000);
  const b = await oldPayment(34000);
  const c = await oldPayment(12000, { customer: shopNoErp });
  await runBridge();
  await excelRow(55000, 502);
  await runBooks();
  assert.equal((await copyOf(a)).books_state, "matched");
  assert.equal((await copyOf(b)).books_state, "matched");
  const noErp = await copyOf(c);
  assert.equal(noErp.books_state, "open");
  assert.match(noErp.books_note, /no ERP id/);
});

test("rejected or deleted in the old module: the copy is voided with the reason", async () => {
  const rejected = await oldPayment(11000);
  const deleted = await oldPayment(12000);
  await runBridge();
  await pool.query("UPDATE payments SET status = 'rejected', rejection_reason = 'wrong shop' WHERE id = $1", [rejected]);
  const copyDeleted = (await copyOf(deleted)).id;
  await pool.query("DELETE FROM payments WHERE id = $1", [deleted]);
  await runBridge();
  assert.match((await copyOf(rejected)).void_reason, /Rejected in the old module: wrong shop/);
  const gone = (await pool.query("SELECT voided_at, void_reason FROM customer_payments WHERE id = $1", [copyDeleted])).rows[0];
  assert.ok(gone.voided_at);
  assert.equal(gone.void_reason, "Deleted in the old module");
});

test("void: the rep fixes his own payment while he still holds the cash; once counted only admin / CEO; a reason is required", async () => {
  const legacy = await oldPayment(15000);
  await runBridge();
  const mine = await copyOf(legacy);
  const noReason = await apiRequest(`/api/payments2/${mine.id}/void`, { method: "POST", cookie: cookies.sales_manager, body: { reason: "" } });
  assert.equal(noReason.status, 400);
  const ok = await apiRequest(`/api/payments2/${mine.id}/void`, { method: "POST", cookie: cookies.sales_manager, body: { reason: "typed twice" } });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.voided_at);

  const counted = await oldPayment(16000, { holder: users.sales_director });
  await runBridge();
  const c = await copyOf(counted);
  assert.equal(c.cash_state, "counted");
  assert.equal((await apiRequest(`/api/payments2/${c.id}/void`, { method: "POST", cookie: cookies.sales_manager, body: { reason: "mistake" } })).status, 403);
  assert.equal((await apiRequest(`/api/payments2/${c.id}/void`, { method: "POST", cookie: cookies.accountant, body: { reason: "mistake" } })).status, 403);
  assert.equal((await apiRequest(`/api/payments2/${c.id}/void`, { method: "POST", cookie: cookies.admin, body: { reason: "mistake" } })).status, 200);
  // a copy voided by a person is never brought back by the copy
  await runBridge();
  assert.ok((await copyOf(counted)).voided_at);
  const history = await apiRequest(`/api/payments2/${c.id}`, { cookie: cookies.admin });
  assert.deepEqual(history.data.events.map((e) => e.kind), ["copied_from_old", "voided"]);
});

test("status: admin / CEO / accountant only; lists Excel cash rows nobody recorded in the app", async () => {
  await excelRow(99000, 777);
  assert.equal((await apiRequest("/api/payments2/status", { cookie: cookies.sales_manager })).status, 403);
  const res = await apiRequest("/api/payments2/status", { cookie: cookies.accountant });
  assert.equal(res.status, 200);
  assert.ok(res.data.counts.total >= 5);
  assert.ok(res.data.unrecorded_cash_rows.some((r) => r.erp === ERP && r.amount === 99000 && r.excel_row === 777));
  assert.equal((await apiRequest("/api/payments2/run", { method: "POST", cookie: cookies.accountant })).status, 403);
  assert.equal((await apiRequest("/api/payments2/run", { method: "POST", cookie: cookies.admin })).status, 200);
});
