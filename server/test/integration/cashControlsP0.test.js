// Improvement plan, Phase 0 "stop losses" (owner, 2026-11-28):
//  0.15 nobody closes their own counting shortfall; "paid in" only by the person who counted it (or admin / CEO), always with a note;
//       the debtor, the counter and admin / CEO are told.
//  0.16 one reviewer cannot take counted cash out of the chain: rejecting or reopening a payment someone else counted or received, or one
//       approved at least once, is admin / CEO only, with a reason, and admin / CEO / the holder are told. Cash still only in the
//       collector's hands keeps the simple reject.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackPayment, trackHandoff } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let users, cookies, customer;

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "sales_manager", "sales_director", "ceo", "accountant", "operations_director"]) {
    users[role] = await createUser(role);
    cookies[role] = await loginAs(users[role].email);
  }
  users.director2 = await createUser("sales_director");
  cookies.director2 = await loginAs(users.director2.email);
  customer = await createCustomer({ created_by: users.sales_manager.id });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

async function seed(amount, { by = "sales_manager", erpApproved = false } = {}) {
  const who = users[by];
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by,
       current_holder_id, approved_from_erp, approved_at)
     VALUES ($1, $2, $3, now(), $4, 'Collector', $5, $4, $4, $6, $7) RETURNING id`,
    [customer.id, customer.name, amount, who.id, erpApproved ? "approved" : "pending", erpApproved, erpApproved ? new Date() : null]
  );
  if (erpApproved) {
    await pool.query("INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by) VALUES ($1, 'pending', 'approved', 'From ERP', NULL)", [rows[0].id]);
  }
  return trackPayment(rows[0].id);
}
async function handAndCount(from, to, ids, counted, note) {
  const r = await apiRequest("/api/cash-handoffs", { method: "POST", cookie: cookies[from], body: { to_user_id: users[to].id, payment_ids: ids } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  trackHandoff(r.data.id);
  const body = counted === undefined ? {} : { counted_amd: counted, note };
  const c = await apiRequest(`/api/cash-handoffs/${r.data.id}/confirm`, { method: "POST", cookie: cookies[to], body });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  return r.data.id;
}
const close = (who, id, how, note) => apiRequest(`/api/cash-handoffs/shortfalls/${id}/close`, { method: "POST", cookie: cookies[who], body: { how, note } });
// notifications are sent after the answer: wait for them a moment
async function notifiedIds(where, params, expectAtLeast) {
  let ids = [];
  for (let i = 0; i < 40; i++) {
    ids = (await pool.query(`SELECT user_id FROM notifications WHERE ${where}`, params)).rows.map((r) => r.user_id);
    if (ids.length >= expectAtLeast) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return new Set(ids);
}

test("0.15: the director cannot close his own shortfall; only the counter (or admin / CEO) closes it, with a note; all sides are told", async () => {
  const p = await seed(40000, { by: "sales_director" });
  const hid = await handAndCount("sales_director", "accountant", [p], 30000, "10,000 missing");
  const { rows: [sf] } = await pool.query("SELECT id, user_id FROM cash_shortfalls WHERE handoff_id = $1", [hid]);
  assert.equal(sf.user_id, users.sales_director.id);

  // the person who owes it: refused, also with a note
  const own = await close("sales_director", sf.id, "paid", "I paid it myself");
  assert.equal(own.status, 403, JSON.stringify(own.data));
  // a reviewer who did not count it: refused
  assert.equal((await close("operations_director", sf.id, "paid", "brought it")).status, 403);
  assert.equal((await close("director2", sf.id, "paid", "brought it")).status, 403);
  // the counter, but no note: refused
  assert.equal((await close("accountant", sf.id, "paid")).status, 400);
  assert.equal((await close("accountant", sf.id, "paid", "ok")).status, 400, "3+ letters");

  // what the screen offers, per card
  const dirView = await apiRequest("/api/cash-handoffs/shortfalls", { cookie: cookies.sales_director });
  const dirCard = dirView.data.open.find((x) => x.id === sf.id);
  assert.deepEqual([dirCard.can_close, dirCard.can_write_off], [false, false]);
  const accView = await apiRequest("/api/cash-handoffs/shortfalls", { cookie: cookies.accountant });
  const accCard = accView.data.open.find((x) => x.id === sf.id);
  assert.deepEqual([accCard.can_close, accCard.can_write_off], [true, false]);
  const ceoCard = (await apiRequest("/api/cash-handoffs/shortfalls", { cookie: cookies.ceo })).data.open.find((x) => x.id === sf.id);
  assert.deepEqual([ceoCard.can_close, ceoCard.can_write_off], [true, true]);

  const ok = await close("accountant", sf.id, "paid", "brought the next morning");
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const { rows: [after] } = await pool.query("SELECT status, closed_by, close_note FROM cash_shortfalls WHERE id = $1", [sf.id]);
  assert.deepEqual([after.status, after.closed_by, after.close_note], ["paid", users.accountant.id, "brought the next morning"]);

  const told = await notifiedIds("type = 'cash_handoff_reviewed' AND title = 'Պակասորդը փակվեց' AND body LIKE $1", ["%brought the next morning%"], 3);
  assert.ok(told.has(users.sales_director.id), "the debtor");
  assert.ok(told.has(users.admin.id) && told.has(users.ceo.id), "the owner's side");
  assert.ok(!told.has(users.accountant.id), "not the closer herself");
});

test("0.15: a rep's shortfall: the director who counted it closes it; another director cannot; the CEO can write it off", async () => {
  const a = await seed(25000);
  const hid = await handAndCount("sales_manager", "sales_director", [a], 20000, "5,000 missing");
  const { rows: [sf] } = await pool.query("SELECT id FROM cash_shortfalls WHERE handoff_id = $1", [hid]);
  assert.equal((await close("director2", sf.id, "paid", "brought it")).status, 403);
  assert.equal((await close("sales_manager", sf.id, "paid", "brought it")).status, 403);
  assert.equal((await close("sales_director", sf.id, "written_off", "lost")).status, 403);
  const repCard = (await apiRequest("/api/cash-handoffs/shortfalls", { cookie: cookies.sales_manager })).data.open.find((x) => x.id === sf.id);
  assert.equal(repCard.can_close, false);
  assert.equal((await close("ceo", sf.id, "written_off", "the rep's mistake, accepted")).status, 200);
  assert.equal((await close("sales_director", sf.id, "paid", "too late")).status, 409, "closed once");
});

test("0.16: cash still only with the rep keeps the simple reject (accountant), no alarm to management", async () => {
  const p = await seed(15000);
  const view = await apiRequest(`/api/payments/${p}`, { cookie: cookies.accountant });
  assert.equal(view.data.can_reject, true);
  const r = await apiRequest(`/api/payments/${p}/reject`, { method: "POST", cookie: cookies.accountant, body: { reason: "x" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await new Promise((res) => setTimeout(res, 200));
  const told = await notifiedIds("type = 'fraud_alert' AND url = $1", [`/#/payments/${p}`], 0);
  assert.equal(told.size, 0);
});

test("0.16: cash the director counted: the accountant cannot reject it (button hidden, Requests: no Deny); the CEO can, with a reason; admin and the holder are told", async () => {
  const p = await seed(60000);
  await handAndCount("sales_manager", "sales_director", [p]);
  const { rows: [row] } = await pool.query("SELECT status, current_holder_id FROM payments WHERE id = $1", [p]);
  assert.deepEqual([row.status, row.current_holder_id], ["pending", users.sales_director.id]);

  const refused = await apiRequest(`/api/payments/${p}/reject`, { method: "POST", cookie: cookies.accountant, body: { reason: "wrong customer" } });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.equal(refused.data.code, "counted_needs_management");
  assert.equal((await apiRequest(`/api/payments/${p}/reject`, { method: "POST", cookie: cookies.operations_director, body: { reason: "wrong customer" } })).status, 403);

  assert.equal((await apiRequest(`/api/payments/${p}`, { cookie: cookies.accountant })).data.can_reject, false);
  assert.equal((await apiRequest(`/api/payments/${p}`, { cookie: cookies.ceo })).data.can_reject, true);
  const accReq = await apiRequest(`/api/requests/payment/${p}`, { cookie: cookies.accountant });
  assert.equal(accReq.status, 200, JSON.stringify(accReq.data));
  assert.deepEqual([accReq.data.can_decide, accReq.data.can_deny], [false, false]);
  const accList = await apiRequest("/api/requests", { cookie: cookies.accountant });
  assert.ok(!accList.data.items.some((i) => i.kind === "payment" && i.id === p), "not in her Requests: she can neither approve nor refuse it");
  const ceoReq = await apiRequest(`/api/requests/payment/${p}`, { cookie: cookies.ceo });
  assert.deepEqual([ceoReq.data.can_decide, ceoReq.data.can_deny], [true, true]);

  assert.equal((await apiRequest(`/api/payments/${p}/reject`, { method: "POST", cookie: cookies.ceo, body: { reason: "x" } })).status, 400, "3+ letters for counted cash");
  const ok = await apiRequest(`/api/payments/${p}/reject`, { method: "POST", cookie: cookies.ceo, body: { reason: "recorded twice" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "rejected");
  const told = await notifiedIds("type = 'fraud_alert' AND url = $1", [`/#/payments/${p}`], 2);
  assert.ok(told.has(users.admin.id), "admin");
  assert.ok(told.has(users.sales_director.id), "the director whose hand-over shrinks");
  assert.ok(!told.has(users.ceo.id), "not the CEO who did it");
});

test("0.16: cash the accountant received: she cannot reopen it (then reject it); admin can, and the CEO is told", async () => {
  const p = await seed(70000);
  await handAndCount("sales_manager", "accountant", [p]);
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [p])).rows[0].status, "approved");
  assert.equal((await apiRequest(`/api/payments/${p}`, { cookie: cookies.accountant })).data.can_reopen, false);
  const refused = await apiRequest(`/api/payments/${p}/return-to-pending`, { method: "POST", cookie: cookies.accountant, body: { reason: "check again" } });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [p])).rows[0].status, "approved", "unchanged");

  const ok = await apiRequest(`/api/payments/${p}/return-to-pending`, { method: "POST", cookie: cookies.admin, body: { reason: "amount typed wrong" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // reopened, it is still counted cash: the accountant still cannot reject it
  assert.equal((await apiRequest(`/api/payments/${p}/reject`, { method: "POST", cookie: cookies.accountant, body: { reason: "gone" } })).status, 403);
  const told = await notifiedIds("type = 'fraud_alert' AND url = $1", [`/#/payments/${p}`], 1);
  assert.ok(told.has(users.ceo.id));
});

test("0.16: a payment approved once (from the Excel) is reopened / rejected by admin or CEO only", async () => {
  const p = await seed(33000, { erpApproved: true });
  assert.equal((await apiRequest(`/api/payments/${p}/return-to-pending`, { method: "POST", cookie: cookies.accountant, body: { reason: "wrong match" } })).status, 403);
  assert.equal((await apiRequest(`/api/payments/${p}/return-to-pending`, { method: "POST", cookie: cookies.ceo, body: { reason: "wrong match" } })).status, 200);
  assert.equal((await apiRequest(`/api/payments/${p}/reject`, { method: "POST", cookie: cookies.accountant, body: { reason: "wrong" } })).status, 403);
});

test("0.16: office cash the accountant took in (for a rep or as herself) is not hers to reject alone", async () => {
  for (const salesManager of ["sales_manager", "accountant"]) {
    const { rows } = await pool.query(
      `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
       VALUES ($1, $2, 21000, now(), $3, 'Collector', 'pending', $4, $3) RETURNING id`,
      [customer.id, customer.name, users[salesManager].id, users.accountant.id]
    );
    const p = trackPayment(rows[0].id);
    assert.equal((await apiRequest(`/api/payments/${p}`, { cookie: cookies.accountant })).data.can_reject, false, salesManager);
    const r = await apiRequest(`/api/payments/${p}/reject`, { method: "POST", cookie: cookies.accountant, body: { reason: "typo" } });
    assert.equal(r.status, 403, `${salesManager}: ${JSON.stringify(r.data)}`);
    assert.equal((await apiRequest(`/api/payments/${p}/reject`, { method: "POST", cookie: cookies.admin, body: { reason: "entered twice" } })).status, 200);
  }
});

test("0.16: the operations director cannot reopen approved cash; cash handed back to the collector still counts as counted", async () => {
  const p = await seed(18000);
  await handAndCount("sales_manager", "accountant", [p]);
  assert.equal((await apiRequest(`/api/payments/${p}/return-to-pending`, { method: "POST", cookie: cookies.operations_director, body: { reason: "check" } })).status, 403);
  // a payment that went to the director and was handed back to the rep in a confirmed hand-over
  const q = await seed(19000);
  await handAndCount("sales_manager", "sales_director", [q]);
  await pool.query("UPDATE payments SET current_holder_id = sales_manager_id WHERE id = $1", [q]);
  assert.equal((await apiRequest(`/api/payments/${q}/reject`, { method: "POST", cookie: cookies.accountant, body: { reason: "gone" } })).status, 403);
});

test("0.15: when admin confirmed a hand-over for the director, the director (who did not count it) cannot close its shortfall", async () => {
  const p = await seed(26000);
  const r = await apiRequest("/api/cash-handoffs", { method: "POST", cookie: cookies.sales_manager, body: { to_user_id: users.sales_director.id, payment_ids: [p] } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  trackHandoff(r.data.id);
  const c = await apiRequest(`/api/cash-handoffs/${r.data.id}/confirm`, { method: "POST", cookie: cookies.admin, body: { counted_amd: 20000, note: "6,000 missing" } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const { rows: [sf] } = await pool.query("SELECT id FROM cash_shortfalls WHERE handoff_id = $1", [r.data.id]);
  assert.equal((await close("sales_director", sf.id, "paid", "brought it")).status, 403);
  assert.equal((await close("admin", sf.id, "paid", "brought it to me")).status, 200);
});
