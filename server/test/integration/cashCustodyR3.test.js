// Payments redesign, release 3a (owner, 2026-11-02): the cash track on the existing screens.
//  - a payment the Excel already shows (approved from the ERP sync) is still cash in the rep's hands until he hands it over;
//  - approving directly (admin / accountant) means the approver received the money: it is in their hands now;
//  - counted less than handed over: the difference stays on the sender's line (cash_shortfalls) until paid in or written off.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackPayment, trackHandoff } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let users, cookies, customer;

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "sales_manager", "sales_director", "ceo", "accountant"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
  customer = await createCustomer({ created_by: users.sales_manager.id });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

async function seed(amount, { erpApproved = false } = {}) {
  const rep = users.sales_manager;
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by,
       current_holder_id, approved_from_erp, approved_at)
     VALUES ($1, $2, $3, now(), $4, 'Rep', $5, $4, $4, $6, $7) RETURNING id`,
    [customer.id, customer.name, amount, rep.id, erpApproved ? "approved" : "pending", erpApproved, erpApproved ? new Date() : null]
  );
  return trackPayment(rows[0].id);
}
const hand = async (to, ids) => {
  const r = await apiRequest("/api/cash-handoffs", { method: "POST", cookie: cookies.sales_manager, body: { to_user_id: users[to].id, payment_ids: ids } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  trackHandoff(r.data.id);
  return r.data.id;
};

test("a payment the Excel already shows is still in the rep's hand-over; the accountant's confirmation records who received it", async () => {
  const erp = await seed(31000, { erpApproved: true });
  const avail = await apiRequest("/api/cash-handoffs/available", { cookie: cookies.sales_manager });
  assert.ok(avail.data.payments.some((p) => p.id === erp), "still to hand over");
  const id = await hand("accountant", [erp]);
  assert.equal((await apiRequest(`/api/cash-handoffs/${id}/confirm`, { method: "POST", cookie: cookies.accountant, body: {} })).status, 200);
  const { rows: [p] } = await pool.query("SELECT status, approved_by, approved_from_erp, current_holder_id FROM payments WHERE id = $1", [erp]);
  assert.equal(p.status, "approved");
  assert.equal(p.approved_by, users.accountant.id);
  assert.equal(p.approved_from_erp, true);
  assert.equal(p.current_holder_id, users.accountant.id);
  const after = await apiRequest("/api/cash-handoffs/available", { cookie: cookies.sales_manager });
  assert.ok(!after.data.payments.some((x) => x.id === erp), "gone once received");
});

test("approving directly: the accountant now holds the money", async () => {
  const id = await seed(12000);
  assert.equal((await apiRequest(`/api/payments/${id}/approve`, { method: "POST", cookie: cookies.accountant })).status, 200);
  const { rows: [p] } = await pool.query("SELECT current_holder_id FROM payments WHERE id = $1", [id]);
  assert.equal(p.current_holder_id, users.accountant.id);
});

test("counted less: the shortfall stays on the rep's line until paid in or written off; who may close it", async () => {
  const a = await seed(50000);
  const b = await seed(20000);
  const id = await hand("sales_director", [a, b]);
  const confirm = await apiRequest(`/api/cash-handoffs/${id}/confirm`, { method: "POST", cookie: cookies.sales_director, body: { counted_amd: 65000, note: "5,000 missing" } });
  assert.equal(confirm.status, 200, JSON.stringify(confirm.data));
  const avail = await apiRequest("/api/cash-handoffs/available", { cookie: cookies.sales_manager });
  assert.equal(avail.data.shortfall_amd, 5000);
  const mine = await apiRequest("/api/cash-handoffs/shortfalls", { cookie: cookies.sales_manager });
  const s = mine.data.open.find((x) => x.handoff_id === id);
  assert.ok(s);
  assert.equal(s.amount_amd, 5000);
  assert.equal(s.counted_by_name, users.sales_director.name);
  assert.equal(mine.data.can_close, false);
  // the rep cannot close his own; the director cannot write it off; a write-off needs a reason
  assert.equal((await apiRequest(`/api/cash-handoffs/shortfalls/${s.id}/close`, { method: "POST", cookie: cookies.sales_manager, body: { how: "paid" } })).status, 403);
  assert.equal((await apiRequest(`/api/cash-handoffs/shortfalls/${s.id}/close`, { method: "POST", cookie: cookies.sales_director, body: { how: "written_off", note: "lost" } })).status, 403);
  assert.equal((await apiRequest(`/api/cash-handoffs/shortfalls/${s.id}/close`, { method: "POST", cookie: cookies.ceo, body: { how: "written_off" } })).status, 400);
  assert.equal((await apiRequest(`/api/cash-handoffs/shortfalls/${s.id}/close`, { method: "POST", cookie: cookies.sales_director, body: { how: "paid", note: "brought the next day" } })).status, 200);
  assert.equal((await apiRequest(`/api/cash-handoffs/shortfalls/${s.id}/close`, { method: "POST", cookie: cookies.sales_director, body: { how: "paid" } })).status, 409, "closed once");
  const again = await apiRequest("/api/cash-handoffs/available", { cookie: cookies.sales_manager });
  assert.equal(again.data.shortfall_amd, 0);
  // counted MORE than handed over: only the note, nothing on the line
  const c = await seed(10000);
  const id2 = await hand("sales_director", [c]);
  await apiRequest(`/api/cash-handoffs/${id2}/confirm`, { method: "POST", cookie: cookies.sales_director, body: { counted_amd: 11000, note: "1,000 extra" } });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cash_shortfalls WHERE handoff_id = $1", [id2])).rows[0].n, 0);
});
