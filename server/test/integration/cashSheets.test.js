// Document flow V1 + V2 (owner, 2026-10-28): the director confirms a rep's cash with the counted amount (a different amount needs a note and
// tells the owner), the confirmation makes the daily cash sheet, the bot fetches and posts it, the accountant marks it recorded (or the sync
// closes it when the Excel has every payment), and the evening / 2-day checks become tasks.
process.env.ERP_SYNC_KEY = "itest-sync-key";
process.env.E2E_RATE_LIMIT_BYPASS_TOKEN = "itest-bypass";
const SYNC = { "x-e2e-rate-limit-bypass": "itest-bypass", "X-Sync-Key": "itest-sync-key" };

import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackPayment, trackHandoff } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { closeSheetsFoundInExcel, runCashSheetJobs } from "../../src/money/cashSheets.js";
import { isWorkingDay } from "../../src/team/vaghinak/engine.js";

let base, rep, director, accountant, owner, repCookie, directorCookie, accountantCookie, customer, erpId;
test.before(async () => {
  base = await startTestServer();
  rep = await createUser("sales_manager", { name: "Sheet Rep" });
  director = await createUser("sales_director", { name: "Sheet Director" });
  accountant = await createUser("accountant");
  owner = await createUser("ceo");
  [repCookie, directorCookie, accountantCookie] = await Promise.all([rep, director, accountant].map((u) => loginAs(u.email)));
  erpId = String(90000 + (Date.now() % 9000));
  customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, erp_customer_id: erpId, name: `Sheet Shop ${erpId}` });
});
test.after(async () => {
  await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [erpId]);
  await pool.query("DELETE FROM tasks WHERE assignee_id = ANY($1)", [[director.id, accountant.id, owner.id]]);
  await cleanupAll();
  await stopTestServer();
});

async function seedPayment(amount, channel = "SM YVN") {
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot,
                           sales_channel, status, created_by, current_holder_id)
     VALUES ($1, $2, $3, $4, now(), $5, $6, $7, 'pending', $5, $5) RETURNING id`,
    [customer.id, customer.name, erpId, amount, rep.id, rep.name, channel]
  );
  trackPayment(rows[0].id);
  return rows[0].id;
}
async function handOver() {
  const res = await apiRequest("/api/cash-handoffs", { method: "POST", cookie: repCookie, body: { to_user_id: director.id, all: true } });
  assert.equal(res.status, 201);
  trackHandoff(res.data.id);
  return res.data;
}
const confirm = (id, body = {}) => apiRequest(`/api/cash-handoffs/${id}/confirm`, { method: "POST", cookie: directorCookie, body });

test("the director confirms with the counted amount; the sheet is made and the bot gets its text and Excel", async () => {
  await seedPayment(150000);
  await seedPayment(80000);
  const h = await handOver();
  const res = await confirm(h.id, { counted_amd: 230000 });
  assert.equal(res.status, 200);
  assert.equal(res.data.counted_amd, 230000);
  assert.ok(res.data.cash_sheet?.id, "the sheet is linked to the hand-off");

  assert.equal((await apiRequest("/api/erp-sync/cash-sheets/pending", { headers: { ...SYNC, "X-Sync-Key": "wrong" } })).status, 401);
  const pending = await apiRequest("/api/erp-sync/cash-sheets/pending", { headers: SYNC });
  const mine = pending.data.sheets.find((s) => s.id === res.data.cash_sheet.id);
  assert.ok(mine);
  assert.match(mine.text, /Sheet Rep/);
  assert.match(mine.text, new RegExp(`${erpId} · Sheet Shop ${erpId} — 150,000`));
  assert.match(mine.text, /230,000 AMD · 2/);
  assert.match(mine.text, /✅/);

  const file = await fetch(`${base}/api/erp-sync/cash-sheets/${mine.id}/xlsx`, { headers: SYNC });
  assert.equal(file.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await file.arrayBuffer()));
  const cash = wb.getWorksheet("Cashflow");
  assert.deepEqual(cash.getRow(1).values.slice(1, 8), ["Date", "Amount", "Currency", "For", "ID", "Source", "Info"], "the workbook's Cash columns A..G");
  assert.deepEqual(cash.getRow(2).values.slice(2, 7), [150000, "AMD", "Oil order", Number(erpId), "Cash YVN"]);
  assert.ok(wb.getWorksheet("Sales"));

  const posted = await apiRequest(`/api/erp-sync/cash-sheets/${mine.id}/posted`, { method: "POST", headers: SYNC, body: { ok: true } });
  assert.equal(posted.status, 200);
  const again = await apiRequest("/api/erp-sync/cash-sheets/pending", { headers: SYNC });
  assert.ok(!again.data.sheets.some((s) => s.id === mine.id), "a posted sheet is not offered again");
});

test("a different counted amount needs a note, then tells the owner", async () => {
  await seedPayment(100000);
  const h = await handOver();
  const noNote = await confirm(h.id, { counted_amd: 90000 });
  assert.equal(noNote.status, 400);
  assert.equal(noNote.data.code, "discrepancy_note_required");
  const res = await confirm(h.id, { counted_amd: 90000, note: "10,000 short, rep brings it tomorrow" });
  assert.equal(res.status, 200);
  assert.equal(res.data.discrepancy_note, "10,000 short, rep brings it tomorrow");
  let told = [];
  for (let i = 0; i < 20 && !told.length; i++) {
    ({ rows: told } = await pool.query("SELECT title FROM notifications WHERE user_id = $1 AND type = 'fraud_alert'", [owner.id]));
    if (!told.length) await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(told[0].title, /−10,000 AMD/);
  let tasks = [];
  for (let i = 0; i < 20 && !tasks.length; i++) {
    ({ rows: tasks } = await pool.query("SELECT id FROM tasks WHERE assignee_id = $1 AND auto_kind = 'cash_discrepancy' AND status = 'open'", [owner.id]));
    if (!tasks.length) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(tasks.length, 1, "and a task to check it");
  const pending = await apiRequest("/api/erp-sync/cash-sheets/pending", { headers: SYNC });
  assert.match(pending.data.sheets.find((s) => s.id === res.data.cash_sheet.id).text, /⚠️ .*90,000 AMD .*−10,000.*short/);
});

test("the accountant marks a sheet recorded (and can undo); a rep sees only his own, a rep cannot mark", async () => {
  const list = await apiRequest("/api/cash-sheets", { cookie: accountantCookie });
  assert.equal(list.status, 200);
  assert.equal(list.data.can_record, true);
  const sheet = list.data.sheets.find((s) => s.rep_name === "Sheet Rep");
  assert.equal((await apiRequest(`/api/cash-sheets/${sheet.id}/recorded`, { method: "POST", cookie: repCookie, body: {} })).status, 403);
  assert.equal((await apiRequest(`/api/cash-sheets/${sheet.id}/recorded`, { method: "POST", cookie: accountantCookie, body: {} })).status, 200);
  let { rows } = await pool.query("SELECT recorded_at, recorded_by, recorded_auto FROM cash_sheets WHERE id = $1", [sheet.id]);
  assert.ok(rows[0].recorded_at);
  assert.equal(rows[0].recorded_by, accountant.id);
  assert.equal((await apiRequest(`/api/cash-sheets/${sheet.id}/recorded`, { method: "POST", cookie: accountantCookie, body: { recorded: false } })).status, 200);
  ({ rows } = await pool.query("SELECT recorded_at FROM cash_sheets WHERE id = $1", [sheet.id]));
  assert.equal(rows[0].recorded_at, null);
  const repList = await apiRequest("/api/cash-sheets", { cookie: repCookie });
  assert.equal(repList.status, 200);
  assert.ok(repList.data.sheets.every((s) => s.rep_name === "Sheet Rep"));
  assert.equal(repList.data.can_record, false);
  const xlsx = await fetch(`${base}/api/cash-sheets/${sheet.id}/xlsx`, { headers: { Cookie: accountantCookie } });
  assert.equal(xlsx.status, 200);
});

test("the sync closes a sheet when the Excel has every payment of it", async () => {
  await pool.query("UPDATE cash_sheets SET recorded_at = NULL WHERE rep_id = $1", [rep.id]);
  const { rows: sheets } = await pool.query("SELECT id FROM cash_sheets WHERE rep_id = $1 ORDER BY id", [rep.id]);
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Yerevan" });
  // the first sheet's two payments are in the Excel, the second's 100,000 is not
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, $2, 150000), ($1, $2, 80000)", [erpId, day]);
  const closed = await closeSheetsFoundInExcel();
  assert.ok(closed.includes(sheets[0].id));
  assert.ok(!closed.includes(sheets[1].id));
  const { rows } = await pool.query("SELECT recorded_auto FROM cash_sheets WHERE id = $1", [sheets[0].id]);
  assert.equal(rows[0].recorded_auto, true);
});

test("checks: a rep's hand-off unconfirmed at 20:00 is a task for the director; a sheet not recorded after 2 days is a task for the accountant", async () => {
  await seedPayment(5000);
  await handOver();
  await pool.query("UPDATE cash_sheets SET created_at = now() - interval '3 days' WHERE rep_id = $1 AND recorded_at IS NULL", [rep.id]);
  const ymd = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Yerevan" });
  const at2030 = new Date(`${ymd}T16:30:00Z`); // 20:30 in Yerevan (UTC+4)
  const workday = await isWorkingDay(pool, ymd);
  const r = await runCashSheetJobs(at2030);
  const open = async (who, kind) => (await pool.query("SELECT id FROM tasks WHERE assignee_id = $1 AND auto_kind = $2 AND status = 'open'", [who, kind])).rows.length;
  assert.equal(await open(director.id, "cash_handoff_unconfirmed"), workday ? 1 : 0);
  assert.equal(await open(accountant.id, "cash_sheet_not_recorded"), workday ? 1 : 0, JSON.stringify(r));
});
