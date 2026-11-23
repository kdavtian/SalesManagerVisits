// The one Cash screen (owner, 2026-11-23): GET /api/cash/overview and the `place` filter of the payments list. The SQL place
// (cashPlaceSql.js) and the shared rule (shared/cashPlace.js) must give the same answer for every payment.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackPayment, trackHandoff } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { CASH_PLACE_JOINS, CASH_PLACE_SELECT, CASH_PLACE_SQL } from "../../src/money/cashPlaceSql.js";
import { cashPlace } from "../../src/shared/cashPlace.js";

const users = {};
const cookies = {};
let customer;
test.before(async () => {
  await startTestServer();
  for (const role of ["admin", "ceo", "sales_manager", "sales_manager2", "sales_director", "accountant", "warehouse_manager"]) {
    users[role] = await createUser(role === "sales_manager2" ? "sales_manager" : role, { name: `Overview ${role}` });
    cookies[role] = await loginAs(users[role].email);
  }
  customer = await createCustomer({ created_by: users.sales_manager.id });
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

async function seed(amount, { holder = "sales_manager", status = "pending", approvedBy = null, fromErp = false } = {}) {
  const rep = users.sales_manager;
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by,
       current_holder_id, approved_by, approved_from_erp, approved_at)
     VALUES ($1, $2, $3, now(), $4, 'Rep', $5, $4, $6, $7, $8, $9) RETURNING id`,
    [customer.id, customer.name, amount, rep.id, status, users[holder].id, approvedBy ? users[approvedBy].id : null, fromErp, status === "approved" ? new Date() : null]
  );
  return trackPayment(rows[0].id);
}
const overview = async (who) => (await apiRequest("/api/cash/overview", { cookie: cookies[who] })).data;
const mineOf = (c, place) => c[place].people.find((p) => p.name === users.sales_manager.name)?.amd ?? 0;

test("the rep sees his own cash and whom it goes to; the company part is for the people who see all payments; the warehouse gets 403", async () => {
  const a = await seed(11000);
  const b = await seed(12000);
  let o = await overview("sales_manager");
  assert.equal(o.me.amd, 23000);
  assert.equal(o.me.n, 2);
  assert.equal(o.me.can_hand_over, true);
  assert.ok(o.me.next?.id, "the next receiver is named");
  assert.equal(o.company, null, "a rep does not see the company's cash");
  assert.equal((await apiRequest("/api/cash/overview", { cookie: cookies.warehouse_manager })).status, 403);
  assert.equal((await apiRequest("/api/cash/overview", {})).status, 401);

  // handed over: off "with me", listed as waiting; the director has it to count; the company sees it on the way
  const h = await apiRequest("/api/cash-handoffs", { method: "POST", cookie: cookies.sales_manager, body: { to_user_id: users.sales_director.id, payment_ids: [a] } });
  trackHandoff(h.data.id);
  o = await overview("sales_manager");
  assert.equal(o.me.amd, 12000);
  assert.deepEqual(o.me.waiting.map((w) => [w.id, w.amd]), [[h.data.id, 11000]]);
  const dir = await overview("sales_director");
  assert.ok(dir.to_confirm.some((x) => x.id === h.data.id && x.mine && x.amd === 11000 && x.n === 1));
  assert.ok(dir.company.on_the_way.amd >= 11000);
  assert.ok(dir.company.with_rep.people.some((p) => p.name === users.sales_manager.name && p.amd === 12000));
  // admin and the CEO see every waiting hand-over (they may decide any); another rep sees none of it
  assert.ok((await overview("ceo")).to_confirm.some((x) => x.id === h.data.id && !x.mine));
  assert.deepEqual((await overview("sales_manager2")).to_confirm, []);

  await apiRequest(`/api/cash-handoffs/${h.data.id}/confirm`, { method: "POST", cookie: cookies.sales_director, body: {} });
  const after = await overview("sales_director");
  assert.equal(after.me.amd, 11000, "counted: now in the director's hands");
  assert.ok(after.company.with_director.people.some((p) => p.name === users.sales_director.name && p.amd === 11000));
  assert.ok(!after.to_confirm.some((x) => x.id === h.data.id));
  // received at the office today: only what a person received today. The Excel approving a payment moves no notes: it stays
  // "with the rep" and is NOT counted as received; the accountant's confirmed hand-over is, once.
  const before = (await overview("admin")).company;
  const excelOnly = await seed(70000, { status: "approved", fromErp: true });
  await pool.query("INSERT INTO payment_status_history (payment_id, old_status, new_status, reason) VALUES ($1, 'pending', 'approved', 'From ERP (payment found in the workbook)')", [excelOnly]);
  let now = (await overview("admin")).company;
  assert.equal(now.office_today.amd, before.office_today.amd, "the Excel's approval is not a receipt");
  assert.equal(mineOf(now, "with_rep") - mineOf(before, "with_rep"), 70000);
  const h2 = await apiRequest("/api/cash-handoffs", { method: "POST", cookie: cookies.sales_manager, body: { to_user_id: users.accountant.id, payment_ids: [b] } });
  trackHandoff(h2.data.id);
  await apiRequest(`/api/cash-handoffs/${h2.data.id}/confirm`, { method: "POST", cookie: cookies.accountant, body: {} });
  now = (await overview("admin")).company;
  assert.equal(now.office_today.amd - before.office_today.amd, 12000);
  assert.equal(now.office_today.n - before.office_today.n, 1);
  // ... and the list behind the number is exactly those payments
  const list = await apiRequest(`/api/payments?customer_id=${customer.id}&received=today`, { cookie: cookies.admin });
  assert.deepEqual(list.data.rows.map((r) => r.id), [b]);
});

test("the payments list filters by place, and a rep only ever gets his own", async () => {
  const withRep = await seed(31000);
  const counted = await seed(32000, { holder: "sales_director" });
  const office = await seed(33000, { holder: "accountant", status: "approved", approvedBy: "accountant" });
  const ids = async (place, who = "admin") => {
    const r = await apiRequest(`/api/payments?customer_id=${customer.id}&place=${place}`, { cookie: cookies[who] });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.rows.every((x) => x.cash_place.place === place), `every row of ${place} is in ${place}`);
    return r.data.rows.map((x) => x.id);
  };
  assert.ok((await ids("with_rep")).includes(withRep));
  assert.ok(!(await ids("with_rep")).includes(counted));
  assert.ok((await ids("with_director")).includes(counted));
  assert.ok((await ids("office")).includes(office));
  assert.deepEqual(await ids("with_rep", "sales_manager2"), [], "another rep's cash is not his to see");
  assert.equal((await apiRequest("/api/payments?place=nowhere", { cookie: cookies.admin })).status, 400);
});

test("the SQL place and the shared rule agree on every payment of this file, in every state", async () => {
  await seed(41000, { status: "approved", fromErp: true }); // the Excel approved it: still with the rep
  await seed(42000, { holder: "ceo", status: "approved", approvedBy: "ceo" }); // taken directly
  await seed(43000, { holder: "admin" });
  const waiting = await seed(46000); // inside a hand-over nobody confirmed yet
  const h = await apiRequest("/api/cash-handoffs", { method: "POST", cookie: cookies.sales_manager, body: { to_user_id: users.sales_director.id, payment_ids: [waiting] } });
  trackHandoff(h.data.id);
  const reopened = await seed(47000, { holder: "accountant" }); // pending again, but the notes are with the accountant
  const orphan = await seed(48000); // its holder was deleted
  await pool.query("UPDATE payments SET current_holder_id = NULL WHERE id = $1", [orphan]);
  void reopened;
  const archive = await seed(45000, { status: "approved", fromErp: true }); // the Excel approved it before the cut-over: the archive
  await pool.query("UPDATE payments SET payment_date = (SELECT payments_cutover FROM app_settings WHERE id = 1) - interval '20 days' WHERE id = $1", [archive]);
  const bad = await seed(44000);
  await pool.query("UPDATE payments SET status = 'rejected' WHERE id = $1", [bad]);
  const { rows } = await pool.query(
    `SELECT p.id, p.status, p.approved_by, p.approved_from_erp, p.pending_handoff_id, ${CASH_PLACE_SELECT}, ${CASH_PLACE_SQL} AS sql_place
     FROM payments p ${CASH_PLACE_JOINS} WHERE p.customer_id = $1`,
    [customer.id]
  );
  assert.ok(rows.length >= 8);
  for (const r of rows) assert.equal(r.sql_place, cashPlace(r).place, `payment ${r.id}: ${JSON.stringify(r)}`);
  assert.deepEqual([...new Set(rows.map((r) => r.sql_place))].sort(), ["office", "on_the_way", "rejected", "with_director", "with_rep"]);
  assert.equal(rows.find((r) => r.id === orphan).sql_place, "with_rep");
  assert.equal(rows.find((r) => r.id === reopened).sql_place, "office");
});
