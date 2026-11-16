// Excel "Balance" rows -> cash handovers (money/excelBalanceHandoffs.js). Made-up boxes, people and amounts. Test mode writes down what it would do and
// changes nothing; live: a waiting hand-over of the same amount is confirmed, cash in hand that adds up exactly becomes a confirmed hand-over to
// the accountant, anything else is a task for the accountant; a pair is acted on once, whatever the re-uploads; who may read / switch it.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { syncExcelBalance } from "../../src/money/excelBalanceHandoffs.js";

const tag = `EB${Date.now()}`;
let rep, rep2, accountant, admin, director, customer, repBox, rep2Box, officeBox, balanceCat, cookies = {}, cutoverBefore;
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

test.before(async () => {
  await startTestServer();
  rep = await createUser("sales_manager", { name: `Rep ${tag}` });
  rep2 = await createUser("sales_manager", { name: `Rep2 ${tag}` });
  accountant = await createUser("accountant");
  admin = await createUser("admin");
  director = await createUser("sales_director");
  for (const [k, u] of Object.entries({ accountant, admin, director, rep })) cookies[k] = await loginAs(u.email);
  customer = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id });
  const box = async (name, holder) => {
    const { rows: [a] } = await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'cash') RETURNING id", [name]);
    await pool.query("INSERT INTO cash_desk_holders (account_id, user_id) VALUES ($1, $2)", [a.id, holder]);
    return a.id;
  };
  repBox = await box(`Cash R ${tag}`, rep.id);
  rep2Box = await box(`Cash R2 ${tag}`, rep2.id);
  officeBox = await box(`Office ${tag}`, accountant.id);
  balanceCat = (await pool.query("SELECT id FROM cash_categories WHERE lower(name) = 'balance'")).rows[0]?.id;
  if (!balanceCat) balanceCat = (await pool.query("INSERT INTO cash_categories (name, kind) VALUES ('Balance', 'internal') RETURNING id")).rows[0].id;
  cutoverBefore = (await pool.query("SELECT payments_cutover::text AS d FROM app_settings WHERE id = 1")).rows[0].d;
  await pool.query("UPDATE app_settings SET payments_cutover = $1, excel_balance_mode = 'shadow' WHERE id = 1", [day(-20)]);
});
test.after(async () => {
  await pool.query("UPDATE app_settings SET payments_cutover = $1, excel_balance_mode = 'shadow' WHERE id = 1", [cutoverBefore]);
  await pool.query("DELETE FROM excel_balance_links WHERE from_account LIKE $1", [`%${tag}`]);
  await pool.query("DELETE FROM cash_entries WHERE account_id = ANY($1::int[])", [[repBox, rep2Box, officeBox]]);
  await pool.query("DELETE FROM tasks WHERE auto_kind = 'cash_balance_check' AND assignee_id = $1", [accountant.id]);
  await pool.query("DELETE FROM cash_sheets WHERE rep_id = ANY($1::int[])", [[rep.id, rep2.id]]);
  await pool.query("DELETE FROM payment_status_history WHERE payment_id IN (SELECT id FROM payments WHERE sales_manager_id = ANY($1::int[]))", [[rep.id, rep2.id]]);
  await pool.query("UPDATE payments SET pending_handoff_id = NULL WHERE sales_manager_id = ANY($1::int[])", [[rep.id, rep2.id]]);
  await pool.query("DELETE FROM cash_handoff_items WHERE handoff_id IN (SELECT id FROM cash_handoffs WHERE from_user_id = ANY($1::int[]))", [[rep.id, rep2.id]]);
  await pool.query("DELETE FROM cash_handoffs WHERE from_user_id = ANY($1::int[])", [[rep.id, rep2.id]]);
  await pool.query("DELETE FROM payments WHERE sales_manager_id = ANY($1::int[])", [[rep.id, rep2.id]]);
  await pool.query("DELETE FROM cash_desk_holders WHERE account_id = ANY($1::int[])", [[repBox, rep2Box, officeBox]]);
  await pool.query("DELETE FROM cash_accounts WHERE id = ANY($1::int[])", [[repBox, rep2Box, officeBox]]);
  await cleanupAll();
  await stopTestServer();
});

const pay = async (holder, amount, daysAgo) =>
  (await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id)
     VALUES ($1, 'Shop', $2, now() - $3::int * interval '1 day', $4, 'Rep', 'pending', $4, $4) RETURNING id`,
    [customer.id, amount, daysAgo, holder]
  )).rows[0].id;
const balance = (account, amount, d) =>
  pool.query("INSERT INTO cash_entries (entry_date, amount, currency, amount_amd, category_id, account_id, origin) VALUES ($1, $2, 'AMD', $2, $3, $4, 'excel')", [d, amount, balanceCat, account]);
const pairRow = async (from, amount, d) => {
  await balance(from, -amount, d);
  await balance(officeBox, amount, d);
};

test("test mode writes down what would happen and changes nothing; live does it once; a mismatch is the accountant's task", async () => {
  const p1 = await pay(rep.id, 20000, 5);
  const p2 = await pay(rep.id, 30000, 4);
  const later = await pay(rep.id, 99000, 0); // after the Balance day: never part of it
  await pairRow(repBox, 50000, day(-2)); // = p1 + p2
  await pairRow(rep2Box, 12345, day(-2)); // rep2 has no cash: a task
  const shadow = await syncExcelBalance();
  assert.equal(shadow.mode, "shadow");
  assert.deepEqual([shadow.created, shadow.task], [1, 1]);
  const still = (await pool.query("SELECT status, current_holder_id FROM payments WHERE id = ANY($1::int[]) ORDER BY id", [[p1, p2]])).rows;
  assert.deepEqual(still.map((r) => [r.status, r.current_holder_id]), [["pending", rep.id], ["pending", rep.id]], "test mode changes nothing");
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM tasks WHERE auto_kind = 'cash_balance_check' AND assignee_id = $1", [accountant.id])).rows[0].n, 0, "no task in test mode");
  const overview = (await apiRequest("/api/cash-handoffs/excel-balance", { cookie: cookies.accountant })).data;
  assert.equal(overview.mode, "shadow");
  assert.ok(overview.links.some((l) => l.from_account === `Cash R ${tag}` && l.outcome === "created"));

  // live (switched by admin; the accountant reads but cannot switch)
  assert.equal((await apiRequest("/api/cash-handoffs/excel-balance/mode", { method: "PUT", cookie: cookies.accountant, body: { mode: "live" } })).status, 403);
  assert.equal((await apiRequest("/api/cash-handoffs/excel-balance", { cookie: cookies.director })).status, 403);
  assert.equal((await apiRequest("/api/cash-handoffs/excel-balance/mode", { method: "PUT", cookie: cookies.admin, body: { mode: "live" } })).status, 200);
  // switched on today, so a pair of 2 days ago would wait: this test switched it on "a week ago"
  await pool.query("UPDATE app_settings SET excel_balance_live_since = $1 WHERE id = 1", [day(-7)]);
  const live = await syncExcelBalance();
  assert.deepEqual([live.created, live.task], [1, 1]);
  const { rows: [h] } = await pool.query("SELECT * FROM cash_handoffs WHERE from_user_id = $1 AND from_excel", [rep.id]);
  assert.deepEqual([h?.status, h?.to_user_id, Math.round(h?.amount_amd)], ["confirmed", accountant.id, 50000]);
  const after = (await pool.query("SELECT id, status, current_holder_id, approved_by FROM payments WHERE id = ANY($1::int[]) ORDER BY id", [[p1, p2, later]])).rows;
  assert.deepEqual(after.map((r) => [r.status, r.current_holder_id]), [["approved", accountant.id], ["approved", accountant.id], ["pending", rep.id]]);
  const sheet = (await pool.query("SELECT recorded_auto FROM cash_sheets WHERE handoff_id = $1", [h.id])).rows[0];
  assert.equal(sheet?.recorded_auto, true, "the cash sheet is already in the Excel");
  const task = (await pool.query("SELECT t.id, (SELECT COUNT(*)::int FROM task_items i WHERE i.task_id = t.id) AS lines FROM tasks t WHERE auto_kind = 'cash_balance_check' AND assignee_id = $1 AND status = 'open'", [accountant.id])).rows[0];
  assert.equal(task?.lines, 1, "the mismatch is one line of the accountant's task");

  // run again (a re-upload): nothing twice
  const again = await syncExcelBalance();
  assert.deepEqual([again.created, again.task, again.confirmed_existing], [0, 0, 0]);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM cash_handoffs WHERE from_user_id = $1", [rep.id])).rows[0].n, 1);
});

test("live: the rep's own hand-over of exactly that amount, waiting for the accountant, is confirmed from the Excel", async () => {
  const p = await pay(rep2.id, 40000, 3);
  const created = await apiRequest("/api/cash-handoffs", { method: "POST", cookie: await loginAs(rep2.email), body: { to_user_id: accountant.id, payment_ids: [p] } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  await pairRow(rep2Box, 40000, day(-1));
  const r = await syncExcelBalance();
  assert.equal(r.confirmed_existing, 1);
  const { rows: [h] } = await pool.query("SELECT status, from_excel, confirmed_by FROM cash_handoffs WHERE id = $1", [created.data.id]);
  assert.deepEqual([h.status, h.from_excel, h.confirmed_by], ["confirmed", true, accountant.id]);
  assert.equal((await pool.query("SELECT status FROM payments WHERE id = $1", [p])).rows[0].status, "approved");
});

test("live acts only from the day it was switched on; the rep's chain through a director is 'already handed over'; a near-twin pair is a task, never a second action", async () => {
  const rep3 = await createUser("sales_manager");
  const box3 = (await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'cash') RETURNING id", [`Cash R3 ${tag}`])).rows[0].id;
  await pool.query("INSERT INTO cash_desk_holders (account_id, user_id) VALUES ($1, $2)", [box3, rep3.id]);
  try {
    // switched to live today: an old pair (before) is not touched, not even as a task
    await pool.query("UPDATE app_settings SET excel_balance_mode = 'shadow' WHERE id = 1");
    assert.equal((await apiRequest("/api/cash-handoffs/excel-balance/mode", { method: "PUT", cookie: cookies.admin, body: { mode: "live" } })).status, 200);
    await pay(rep3.id, 7000, 9);
    await pairRow(box3, 7000, day(-5));
    let r = await syncExcelBalance();
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM excel_balance_links WHERE mode = 'live' AND from_account = $1", [`Cash R3 ${tag}`])).rows[0].n, 0, "before the switch: untouched");
    assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM cash_handoffs WHERE from_user_id = $1", [rep3.id])).rows[0].n, 0);
    // the usual chain: the rep handed 15,000 to the director (confirmed) -> the Excel pair of 15,000 today is "already"
    const p = await pay(rep3.id, 15000, 0);
    const toDirector = await apiRequest("/api/cash-handoffs", { method: "POST", cookie: await loginAs(rep3.email), body: { to_user_id: director.id, payment_ids: [p] } });
    assert.equal(toDirector.status, 201, JSON.stringify(toDirector.data));
    assert.equal((await apiRequest(`/api/cash-handoffs/${toDirector.data.id}/confirm`, { method: "POST", cookie: cookies.director, body: {} })).status, 200);
    await pairRow(box3, 15000, day(0));
    r = await syncExcelBalance();
    assert.equal(r.already, 1);
    // the same amount for the same rep again the next day (a corrected date / a re-typed row): a task line, never a second action
    await pairRow(box3, 15000, day(1));
    r = await syncExcelBalance();
    assert.deepEqual([r.task, r.created, r.confirmed_existing], [1, 0, 0]);
  } finally {
    await pool.query("UPDATE app_settings SET excel_balance_mode = 'shadow', excel_balance_live_since = NULL WHERE id = 1");
    await pool.query("DELETE FROM excel_balance_links WHERE from_account = $1", [`Cash R3 ${tag}`]);
    await pool.query("DELETE FROM cash_entries WHERE account_id = $1", [box3]);
    await pool.query("DELETE FROM cash_sheets WHERE rep_id = $1", [rep3.id]);
    await pool.query("DELETE FROM payment_status_history WHERE payment_id IN (SELECT id FROM payments WHERE sales_manager_id = $1)", [rep3.id]);
    await pool.query("UPDATE payments SET pending_handoff_id = NULL WHERE sales_manager_id = $1", [rep3.id]);
    await pool.query("DELETE FROM cash_handoff_items WHERE handoff_id IN (SELECT id FROM cash_handoffs WHERE from_user_id = $1)", [rep3.id]);
    await pool.query("DELETE FROM cash_handoffs WHERE from_user_id = $1", [rep3.id]);
    await pool.query("DELETE FROM payments WHERE sales_manager_id = $1", [rep3.id]);
    await pool.query("DELETE FROM cash_desk_holders WHERE account_id = $1", [box3]);
    await pool.query("DELETE FROM cash_accounts WHERE id = $1", [box3]);
  }
});

test("payments with fractions: a hand-over is created only when they add up exactly, and its amount is theirs", async () => {
  const rep4 = await createUser("sales_manager");
  const box4 = (await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'cash') RETURNING id", [`Cash R4 ${tag}`])).rows[0].id;
  await pool.query("INSERT INTO cash_desk_holders (account_id, user_id) VALUES ($1, $2)", [box4, rep4.id]);
  await pool.query("UPDATE app_settings SET excel_balance_mode = 'live', excel_balance_live_since = $1 WHERE id = 1", [day(-7)]);
  try {
    await pay(rep4.id, 100.49, 3);
    await pay(rep4.id, 100.49, 2);
    await pairRow(box4, 200, day(-1)); // 200.98 in hand: not exactly 200 -> a task, nothing created
    let r = await syncExcelBalance();
    assert.deepEqual([r.created, r.task], [0, 1]);
    await pairRow(box4, 200.98, day(0)); // exactly what they add up to
    r = await syncExcelBalance();
    assert.equal(r.created, 1);
    const { rows: [h] } = await pool.query("SELECT amount_amd::text AS amount FROM cash_handoffs WHERE from_user_id = $1 AND from_excel", [rep4.id]);
    assert.equal(Number(h.amount), 200.98);
  } finally {
    await pool.query("UPDATE app_settings SET excel_balance_mode = 'shadow', excel_balance_live_since = NULL WHERE id = 1");
    await pool.query("DELETE FROM excel_balance_links WHERE from_account = $1", [`Cash R4 ${tag}`]);
    await pool.query("DELETE FROM cash_entries WHERE account_id = $1", [box4]);
    await pool.query("DELETE FROM cash_sheets WHERE rep_id = $1", [rep4.id]);
    await pool.query("DELETE FROM payment_status_history WHERE payment_id IN (SELECT id FROM payments WHERE sales_manager_id = $1)", [rep4.id]);
    await pool.query("DELETE FROM cash_handoff_items WHERE handoff_id IN (SELECT id FROM cash_handoffs WHERE from_user_id = $1)", [rep4.id]);
    await pool.query("DELETE FROM cash_handoffs WHERE from_user_id = $1", [rep4.id]);
    await pool.query("DELETE FROM payments WHERE sales_manager_id = $1", [rep4.id]);
    await pool.query("DELETE FROM cash_desk_holders WHERE account_id = $1", [box4]);
    await pool.query("DELETE FROM cash_accounts WHERE id = $1", [box4]);
  }
});

test("off: nothing is read", async () => {
  await pool.query("UPDATE app_settings SET excel_balance_mode = 'off' WHERE id = 1");
  assert.deepEqual(await syncExcelBalance(), { mode: "off", pairs: 0 });
  await pool.query("UPDATE app_settings SET excel_balance_mode = 'shadow' WHERE id = 1");
});
