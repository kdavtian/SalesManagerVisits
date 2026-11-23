// One route for cash (owner, 2026-11-23): rep -> sales director -> accountant. The director's cash no longer stops at the CEO; the CEO
// (like admin) may still confirm or refuse any hand-over and approve directly; the App configuration switch brings the accountant's
// approval without a hand-over back; a cash sheet closes by itself also when the Excel booked its payments as a sum.
// ISOLATED (test/isolated-tests.txt): it flips the one app_settings.accountant_direct_approval every payments test reads.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackPayment, trackHandoff } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { closeSheetsFoundInExcel } from "../../src/money/cashSheets.js";

const users = {};
const cookies = {};
let customer;
test.before(async () => {
  await startTestServer();
  for (const role of ["admin", "ceo", "sales_manager", "sales_director", "accountant", "operations_director"]) {
    users[role] = await createUser(role, { name: `Route ${role}` });
    cookies[role] = await loginAs(users[role].email);
  }
  customer = await createCustomer({ created_by: users.sales_manager.id, erp_customer_id: String(70000 + (Date.now() % 9000)) });
});
test.after(async () => {
  await pool.query("UPDATE app_settings SET accountant_direct_approval = false WHERE id = 1");
  await pool.query("DELETE FROM customer_payments WHERE customer_id = $1", [customer.id]);
  await pool.query("DELETE FROM tasks WHERE assignee_id = ANY($1) OR creator_id = ANY($1)", [Object.values(users).map((u) => u.id)]);
  await cleanupAll();
  await stopTestServer();
});

async function seed(amount, holder = "sales_manager") {
  const rep = users.sales_manager;
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
     VALUES ($1, $2, $3, $4, now(), $5, 'Rep', 'pending', $5, $6) RETURNING id`,
    [customer.id, customer.name, customer.erp_customer_id, amount, rep.id, users[holder].id]
  );
  return trackPayment(rows[0].id);
}
const hand = async (from, to, ids) => {
  const r = await apiRequest("/api/cash-handoffs", { method: "POST", cookie: cookies[from], body: { to_user_id: users[to].id, payment_ids: ids } });
  if (r.status === 201) trackHandoff(r.data.id);
  return r;
};

test("the director's cash goes to the accountant only: the CEO and the operations director are no longer a stop", async () => {
  const id = await seed(40000, "sales_director");
  const avail = await apiRequest("/api/cash-handoffs/available", { cookie: cookies.sales_director });
  assert.deepEqual(avail.data.recipient_roles, ["accountant"]);
  assert.ok(avail.data.recipients.every((r) => r.role === "accountant"));
  assert.equal((await hand("sales_director", "ceo", [id])).status, 400);
  assert.equal((await hand("sales_director", "operations_director", [id])).status, 400);
  const ok = await hand("sales_director", "accountant", [id]);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal((await apiRequest(`/api/cash-handoffs/${ok.data.id}/confirm`, { method: "POST", cookie: cookies.accountant, body: {} })).status, 200);
  const { rows: [p] } = await pool.query("SELECT status, current_holder_id FROM payments WHERE id = $1", [id]);
  assert.deepEqual([p.status, p.current_holder_id], ["approved", users.accountant.id]);
});

test("cash a CEO still holds from before can go on to the accountant", async () => {
  const id = await seed(15000, "ceo");
  const ok = await hand("ceo", "accountant", [id]);
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal((await apiRequest(`/api/cash-handoffs/${ok.data.id}/confirm`, { method: "POST", cookie: cookies.accountant, body: {} })).status, 200);
});

test("the CEO keeps every right: confirms and refuses a hand-over addressed to somebody else; the operations director may not", async () => {
  const a = await seed(21000);
  const h1 = await hand("sales_manager", "sales_director", [a]);
  assert.equal(h1.status, 201);
  assert.equal((await apiRequest(`/api/cash-handoffs/${h1.data.id}/confirm`, { method: "POST", cookie: cookies.operations_director, body: {} })).status, 403);
  const confirmed = await apiRequest(`/api/cash-handoffs/${h1.data.id}/confirm`, { method: "POST", cookie: cookies.ceo, body: {} });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  const { rows: [p] } = await pool.query("SELECT current_holder_id, status FROM payments WHERE id = $1", [a]);
  assert.deepEqual([p.current_holder_id, p.status], [users.sales_director.id, "pending"], "the cash is with the receiver it was addressed to");
  const { rows: [h] } = await pool.query("SELECT confirmed_by FROM cash_handoffs WHERE id = $1", [h1.data.id]);
  assert.equal(h.confirmed_by, users.ceo.id, "and the record says who confirmed");

  const b = await seed(22000);
  const h2 = await hand("sales_manager", "accountant", [b]);
  const refused = await apiRequest(`/api/cash-handoffs/${h2.data.id}/reject`, { method: "POST", cookie: cookies.ceo, body: { reason: "wrong payments" } });
  assert.equal(refused.status, 200, JSON.stringify(refused.data));
  const { rows: [q] } = await pool.query("SELECT current_holder_id, pending_handoff_id FROM payments WHERE id = $1", [b]);
  assert.deepEqual([q.current_holder_id, q.pending_handoff_id], [users.sales_manager.id, null], "back with the rep");
});

test("the switch: only admin sets it; ON lets the accountant approve cash that was never handed over, OFF refuses again", async () => {
  const id = await seed(33000);
  const list = async () => (await apiRequest(`/api/payments?customer_id=${customer.id}`, { cookie: cookies.accountant })).data.rows.find((r) => r.id === id);
  assert.equal((await list()).can_approve, false);
  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: cookies.accountant, body: { accountant_direct_approval: true } })).status, 403);
  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: cookies.admin, body: { accountant_direct_approval: "yes" } })).status, 400);
  const on = await apiRequest("/api/settings", { method: "PATCH", cookie: cookies.admin, body: { accountant_direct_approval: true } });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.accountant_direct_approval, true);
  assert.equal((await apiRequest("/api/settings", { cookie: cookies.admin })).data.accountant_direct_approval, true);
  assert.equal((await list()).can_approve, true);
  const off = await apiRequest("/api/settings", { method: "PATCH", cookie: cookies.admin, body: { accountant_direct_approval: false } });
  assert.equal(off.data.accountant_direct_approval, false);
  assert.equal((await apiRequest(`/api/payments/${id}/approve`, { method: "POST", cookie: cookies.accountant })).status, 409);
  await apiRequest("/api/settings", { method: "PATCH", cookie: cookies.admin, body: { accountant_direct_approval: true } });
  const ok = await apiRequest(`/api/payments/${id}/approve`, { method: "POST", cookie: cookies.accountant });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.current_holder_id, users.accountant.id);
  await apiRequest("/api/settings", { method: "PATCH", cookie: cookies.admin, body: { accountant_direct_approval: false } });
});

test("a cash sheet closes by itself when the books matched its payments as a sum; the mark by hand is offered only for a late sheet", async () => {
  const a = await seed(60000);
  const b = await seed(40000);
  const h = await hand("sales_manager", "sales_director", [a, b]);
  assert.equal((await apiRequest(`/api/cash-handoffs/${h.data.id}/confirm`, { method: "POST", cookie: cookies.sales_director, body: {} })).status, 200);
  const { rows: [sheet] } = await pool.query("SELECT id FROM cash_sheets WHERE handoff_id = $1", [h.data.id]);
  assert.ok(sheet, "the director's confirmation made the sheet");
  // nothing in the Excel yet: stays open, and a fresh sheet offers no mark
  assert.ok(!(await closeSheetsFoundInExcel()).includes(sheet.id));
  let row = (await apiRequest("/api/cash-sheets", { cookie: cookies.accountant })).data.sheets.find((s) => s.id === sheet.id);
  assert.equal(row.late, false);
  // the accountant booked the day as ONE row of 100,000: the books matched both payments to it (payments2), the exact rule finds neither
  for (const id of [a, b]) {
    await pool.query(
      `INSERT INTO customer_payments (customer_id, customer_name_snapshot, amount_amd, paid_at, pay_day, method, collected_by, cash_state, books_state, source, legacy_payment_id, created_by)
       SELECT customer_id, customer_name_snapshot, amount_amd, payment_date, payment_date::date, 'cash', sales_manager_id, 'counted', $2, 'bridge', id, created_by FROM payments WHERE id = $1`,
      [id, id === a ? "matched" : "open"]
    );
  }
  assert.ok(!(await closeSheetsFoundInExcel()).includes(sheet.id), "one payment still open in the books");
  await pool.query("UPDATE customer_payments SET books_state = 'matched' WHERE legacy_payment_id = $1", [b]);
  assert.ok((await closeSheetsFoundInExcel()).includes(sheet.id));
  // a sheet still open after 2 days is `late`: the way out by hand, for the accountant, admin and the CEO
  await pool.query("UPDATE cash_sheets SET recorded_at = NULL, created_at = now() - interval '3 days' WHERE id = $1", [sheet.id]);
  await pool.query("UPDATE customer_payments SET books_state = 'open' WHERE legacy_payment_id = ANY($1)", [[a, b]]);
  row = (await apiRequest("/api/cash-sheets", { cookie: cookies.ceo })).data.sheets.find((s) => s.id === sheet.id);
  assert.equal(row.late, true);
  assert.equal((await apiRequest(`/api/cash-sheets/${sheet.id}/recorded`, { method: "POST", cookie: cookies.ceo, body: {} })).status, 200);
  assert.equal((await apiRequest(`/api/cash-sheets/${sheet.id}/recorded`, { method: "POST", cookie: cookies.sales_director, body: {} })).status, 403);
});
