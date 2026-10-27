// Cashflow module (owner, 2026-10-23): Excel ledger -> app. Parsing, replacing the Excel-origin rows only, balances, filters, roles.
// The deploy script runs this suite against the REAL database, so the whole cashflow ledger is snapshotted first and restored after.
process.env.ERP_SYNC_KEY = "itest-sync-key";
process.env.E2E_RATE_LIMIT_BYPASS_TOKEN = "itest-bypass";
const BYPASS = { "x-e2e-rate-limit-bypass": "itest-bypass" };

import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, apiFormRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { normalizeCashRow, readCashWorkbook, ymd } from "../../src/cashflow.js";

let snap;
let accountant, director, ops, admin, rep, cookies;
test.before(async () => {
  await startTestServer();
  snap = {
    entries: (await pool.query("SELECT * FROM cash_entries")).rows,
    accounts: (await pool.query("SELECT id FROM cash_accounts")).rows.map((r) => r.id),
    categories: (await pool.query("SELECT id FROM cash_categories")).rows.map((r) => r.id),
    syncMax: (await pool.query("SELECT COALESCE(MAX(id), 0) AS m FROM cash_syncs")).rows[0].m,
    logMax: (await pool.query("SELECT COALESCE(MAX(id), 0) AS m FROM cash_entry_log")).rows[0].m,
    reqMax: (await pool.query("SELECT COALESCE(MAX(id), 0) AS m FROM cash_entry_requests")).rows[0].m,
  };
  accountant = await createUser("accountant");
  director = await createUser("sales_director");
  ops = await createUser("operations_director");
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  cookies = {};
  for (const [k, u] of Object.entries({ accountant, director, ops, admin, rep })) cookies[k] = await loginAs(u.email);
});
test.after(async () => {
  // put the real ledger back (same ids), then drop what this file invented
  await pool.query("DELETE FROM cash_entries");
  if (snap.entries.length) await pool.query("INSERT INTO cash_entries SELECT * FROM jsonb_populate_recordset(NULL::cash_entries, $1::jsonb)", [JSON.stringify(snap.entries)]);
  await pool.query("DELETE FROM cash_accounts WHERE NOT (id = ANY($1))", [snap.accounts]);
  await pool.query("DELETE FROM cash_categories WHERE NOT (id = ANY($1))", [snap.categories]);
  await pool.query("DELETE FROM cash_syncs WHERE id > $1", [snap.syncMax]);
  await pool.query("DELETE FROM cash_entry_log WHERE id > $1", [snap.logMax]);
  await pool.query("DELETE FROM cash_entry_requests WHERE id > $1", [snap.reqMax]);
  await cleanupAll();
  await stopTestServer();
});

const ROWS = [
  { date: "2031-01-05", amount: 1000000, currency: "AMD", for: "Oil order", id: "10001", source: "Cash ITest", info: "payment", sales_rep: "SM YVN" },
  { date: "2031-01-06", amount: -250000, currency: "AMD", for: "Fuel", id: "70KK770", source: "Cash ITest", info: "fuel" },
  { date: "2031-01-07", amount: -400000, currency: "AMD", for: "To bank", source: "Cash ITest", info: "to the bank" },
  { date: "2031-01-07", amount: 400000, currency: "AMD", for: "To bank", source: "ITest Bank AMD", info: "from the cash box" },
  { date: "2031-01-08", amount: 1000, currency: "USD", currency_rate: 380, for: "Investment", source: "ITest Bank USD", info: "usd in" },
  { date: "2031-02-01", amount: -50000, currency: "AMD", for: "Brand New Category", source: "cash itest", info: "case-insensitive account" },
];

function csrf() {
  return {};
}

test("normalising a row: dates, USD conversion, customer id vs free text, skips", () => {
  assert.equal(ymd(new Date("2031-03-04T00:00:00Z")), "2031-03-04");
  assert.equal(ymd("04.03.2031"), "2031-03-04");
  assert.equal(ymd("nope"), null);
  const oil = normalizeCashRow({ date: "2031-03-04", amount: "1 500 000", for: "Oil order", id: "10418", source: " Cash YVN " });
  assert.equal(oil.erp_customer_id, "10418");
  assert.equal(oil.ref, null);
  assert.equal(oil.amount, 1500000);
  assert.equal(oil.account, "Cash YVN");
  assert.equal(oil.amount_amd, 1500000);
  const fuel = normalizeCashRow({ date: "2031-03-04", amount: -1000, for: "Fuel", id: "70KK770", source: "Cash" });
  assert.equal(fuel.erp_customer_id, null);
  assert.equal(fuel.ref, "70KK770");
  const usd = normalizeCashRow({ date: "2031-03-04", amount: 100, currency: "usd", currency_rate: 385, for: "Investment", source: "EvocaBank USD" });
  assert.equal(usd.currency, "USD");
  assert.equal(usd.amount_amd, 38500);
  assert.equal(normalizeCashRow({ date: null, amount: 5 }).skip, "no date");
  assert.equal(normalizeCashRow({ date: "2031-03-04", amount: "x" }).skip, "no amount");
});

async function workbookBuffer({ headerRow = 9 } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Orders");
  const ws = wb.addWorksheet("Cashflow");
  ws.getCell("A1").value = "control panel";
  const header = ["Date", "Amount", "Currency", "For", "ID", "Source", "Info", "Customer_Name", "Currency Rate", "Amount AMD", "Sales Rep", "TransactionID"];
  header.forEach((h, i) => (ws.getRow(headerRow).getCell(i + 1).value = h));
  ROWS.slice(0, 3).forEach((r, i) => {
    const row = ws.getRow(headerRow + 1 + i);
    row.getCell(1).value = new Date(`${r.date}T00:00:00Z`);
    row.getCell(2).value = r.amount;
    row.getCell(3).value = r.currency;
    row.getCell(4).value = { formula: '"Oil order"', result: r.for }; // a formula cell keeps its cached result
    row.getCell(5).value = r.id ?? null;
    row.getCell(6).value = r.source;
    row.getCell(7).value = r.info;
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("reading the workbook: the header row is found by its labels, formula cells give their result", async () => {
  for (const headerRow of [9, 3]) {
    const rows = await readCashWorkbook(await workbookBuffer({ headerRow }));
    assert.equal(rows.length, 3, `header on row ${headerRow}`);
    assert.equal(rows[0].for, "Oil order");
    assert.equal(rows[1].amount, -250000);
    assert.equal(rows[0].excel_row, headerRow + 1);
  }
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Something else");
  await assert.rejects(readCashWorkbook(Buffer.from(await wb.xlsx.writeBuffer())), /Cashflow/);
});

test("only the owner's roles see the cashflow; sales roles and a sales director do not", async () => {
  for (const k of ["rep", "director"]) assert.equal((await apiRequest("/api/cashflow/meta", { cookie: cookies[k] })).status, 403, k);
  for (const k of ["accountant", "ops", "admin"]) assert.equal((await apiRequest("/api/cashflow/meta", { cookie: cookies[k] })).status, 200, k);
  assert.equal((await apiRequest("/api/cashflow/meta", { cookie: cookies.ops })).data.can_edit, false);
  assert.equal((await apiRequest("/api/cashflow/meta", { cookie: cookies.accountant })).data.can_edit, true);
});

test("the bot's push replaces the Excel rows only: manual rows stay, accounts and categories are created, case does not split an account", async () => {
  // a manual row that must survive
  const { rows: [cat] } = await pool.query("SELECT id FROM cash_categories WHERE name = 'Office'");
  await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ('ITest Manual Box', 'cash') ON CONFLICT DO NOTHING");
  const { rows: [acc] } = await pool.query("SELECT id FROM cash_accounts WHERE name = 'ITest Manual Box'");
  await pool.query("INSERT INTO cash_entries (entry_date, amount, currency, amount_amd, category_id, account_id, origin, info) VALUES ('2031-01-02', -777, 'AMD', -777, $1, $2, 'manual', 'itest manual')", [cat.id, acc.id]);

  const bad = await apiRequest("/api/erp-sync/cashflow-ledger", { method: "POST", headers: { ...BYPASS, "X-Sync-Key": "wrong" }, body: { rows: ROWS } });
  assert.equal(bad.status, 401);
  const empty = await apiRequest("/api/erp-sync/cashflow-ledger", { method: "POST", headers: { ...BYPASS, "X-Sync-Key": "itest-sync-key" }, body: { rows: [] } });
  assert.equal(empty.status, 400);
  const res = await apiRequest("/api/erp-sync/cashflow-ledger", { method: "POST", headers: { ...BYPASS, "X-Sync-Key": "itest-sync-key" }, body: { rows: ROWS, file_name: "itest.xlsx" } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.rows, 6);
  assert.equal(res.data.accounts_added, 3); // Cash ITest, ITest Bank AMD, ITest Bank USD ("cash itest" is the same account)
  assert.equal(res.data.categories_added, 1);
  const { rows: all } = await pool.query("SELECT origin, COUNT(*)::int AS n FROM cash_entries GROUP BY origin");
  const by = Object.fromEntries(all.map((r) => [r.origin, r.n]));
  assert.equal(by.excel, 6, "the old Excel rows are gone, only this push remains");
  assert.equal(by.manual, 1, "the manual row survived");
  // pushing again does not duplicate
  await apiRequest("/api/erp-sync/cashflow-ledger", { method: "POST", headers: { ...BYPASS, "X-Sync-Key": "itest-sync-key" }, body: { rows: ROWS } });
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM cash_entries WHERE origin = 'excel'")).rows[0].n, 6);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM cash_accounts WHERE lower(name) = 'cash itest'")).rows[0].n, 1);
});

test("meta, entries and summary: balances per account and currency, internal moves are not income or expense, filters", async () => {
  const meta = (await apiRequest("/api/cashflow/meta?as_of=2031-12-31", { cookie: cookies.accountant })).data;
  const acc = Object.fromEntries(meta.accounts.map((a) => [a.name, a]));
  const cash = acc["Cash ITest"].balances.find((b) => b.currency === "AMD");
  assert.equal(cash.balance, 1000000 - 250000 - 400000 - 50000);
  assert.equal(acc["ITest Bank AMD"].balances[0].balance, 400000);
  const usd = acc["ITest Bank USD"].balances[0];
  assert.equal(usd.currency, "USD");
  assert.equal(usd.balance, 1000);
  assert.equal(usd.amd, 380000);
  assert.equal(acc["Cash ITest"].kind, "cash");
  assert.equal(acc["ITest Bank AMD"].kind, "bank");
  assert.equal(meta.last_sync.via, "bot");
  assert.equal(meta.usd_rate, 380);
  // as of an earlier date: nothing yet on the Jan 05 account
  const early = (await apiRequest("/api/cashflow/meta?as_of=2031-01-04", { cookie: cookies.accountant })).data;
  assert.equal(early.accounts.find((a) => a.name === "Cash ITest").balances.length, 0);

  const sum = (await apiRequest("/api/cashflow/summary?from=2031-01-01&to=2031-12-31", { cookie: cookies.accountant })).data;
  // income: the customer payment + the USD investment (owner money counts as in, 380,000); expenses: fuel + the new category; "To bank" is internal and NOT counted
  assert.equal(sum.in_amd, 1000000 + 380000);
  assert.equal(sum.out_amd, 250000 + 50000 + 777); // + the manual Office row
  const toBank = sum.by_category.find((c) => c.name === "To bank");
  assert.equal(toBank.kind, "internal");
  assert.equal(toBank.in_amd, 400000);
  assert.deepEqual(sum.by_month.map((m) => m.month), ["2031-01", "2031-02"]);

  const list = (await apiRequest("/api/cashflow/entries?from=2031-01-01&to=2031-12-31", { cookie: cookies.accountant })).data;
  assert.equal(list.total, 7); // 6 from Excel + the manual row
  assert.equal(list.entries[0].date, "2031-02-01"); // newest first
  const oil = (await apiRequest("/api/cashflow/entries?from=2031-01-01&to=2031-12-31&customer=10001", { cookie: cookies.accountant })).data;
  assert.equal(oil.total, 1);
  assert.equal(oil.entries[0].category, "Oil order");
  const fuel = (await apiRequest("/api/cashflow/entries?from=2031-01-01&to=2031-12-31&q=70KK", { cookie: cookies.accountant })).data;
  assert.equal(fuel.total, 1);
  const outs = (await apiRequest("/api/cashflow/entries?from=2031-01-01&to=2031-12-31&dir=out&kind=expense", { cookie: cookies.accountant })).data;
  assert.equal(outs.total, 3); // fuel, the new category, the manual Office row
  const page = (await apiRequest("/api/cashflow/entries?from=2031-01-01&to=2031-12-31&limit=3", { cookie: cookies.accountant })).data;
  assert.equal(page.entries.length, 3);
  assert.equal(page.has_more, true);
});

test("an uploaded workbook refreshes the ledger (accountant / CEO / admin); an operations director cannot", async () => {
  const buf = await workbookBuffer();
  const form = () => {
    const f = new FormData();
    f.set("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "Castrol_test.xlsx");
    return f;
  };
  assert.equal((await apiFormRequest("/api/cashflow/import", { cookie: cookies.ops, form: form() })).status, 403);
  assert.equal((await apiFormRequest("/api/cashflow/import", { cookie: cookies.rep, form: form() })).status, 403);
  assert.equal((await apiFormRequest("/api/cashflow/import", { cookie: cookies.accountant, form: new FormData() })).status, 400);
  const res = await apiFormRequest("/api/cashflow/import", { cookie: cookies.accountant, form: form() });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.rows, 3);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM cash_entries WHERE origin = 'excel'")).rows[0].n, 3);
  const meta = (await apiRequest("/api/cashflow/meta", { cookie: cookies.admin })).data;
  assert.equal(meta.last_sync.via, "upload");
  assert.equal(meta.last_sync.file_name, "Castrol_test.xlsx");
});

// ---- phase 2: add / edit / delete in the app ------------------------------------------------------------------------------------------------
test("entries made in the app: direction + positive amount, USD with a rate, edit, delete; Excel rows are read-only; roles", async () => {
  const send = (who, path, method, body) => apiRequest(`/api/cashflow${path}`, { method, cookie: cookies[who], body });
  const acc = (await send("accountant", "/accounts", "POST", { name: `Cash ITest2 ${Date.now()}`, kind: "cash" })).data.id;
  assert.ok(acc);
  assert.equal((await send("accountant", "/accounts", "POST", { name: "" })).status, 400);
  const cat = (await send("accountant", "/categories", "POST", { name: `ITest cat ${Date.now()}`, kind: "expense" })).data.id;
  assert.equal((await send("accountant", "/categories", "POST", { name: "x", kind: "nope" })).status, 400);
  const base = { date: "2026-10-20", direction: "out", amount: 12500, currency: "AMD", account_id: acc, category_id: cat, info: "ITest fuel" };

  assert.equal((await send("ops", "/entries", "POST", base)).status, 403, "operations director only reads");
  assert.equal((await send("director", "/entries", "POST", base)).status, 403);
  assert.equal((await send("accountant", "/entries", "POST", { ...base, amount: 0 })).status, 400);
  assert.equal((await send("accountant", "/entries", "POST", { ...base, direction: "sideways" })).status, 400);
  assert.equal((await send("accountant", "/entries", "POST", { ...base, account_id: 999999999 })).status, 400);
  assert.equal((await send("accountant", "/entries", "POST", { ...base, date: "20.10.2026" })).status, 400);

  const made = await send("accountant", "/entries", "POST", base);
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const row = async (id) => (await pool.query("SELECT amount::float8 AS amount, amount_amd::float8 AS amount_amd, currency, fx_rate::float8 AS fx, origin, created_by FROM cash_entries WHERE id = $1", [id])).rows[0];
  let r = await row(made.data.id);
  assert.deepEqual([r.amount, r.amount_amd, r.origin, r.created_by], [-12500, -12500, "manual", accountant.id]);

  const usd = await send("admin", "/entries", "POST", { ...base, direction: "in", amount: 200, currency: "USD", fx_rate: 380 });
  r = await row(usd.data.id);
  assert.deepEqual([r.amount, r.amount_amd, r.fx], [200, 76000, 380]);

  assert.equal((await send("accountant", `/entries/${made.data.id}`, "PUT", { ...base, amount: 30000, direction: "in" })).status, 200);
  r = await row(made.data.id);
  assert.deepEqual([r.amount, r.amount_amd], [30000, 30000]);
  const listed = (await send("accountant", "/entries?q=ITest%20fuel&limit=50", "GET")).data.entries.find((e) => e.id === made.data.id);
  assert.equal(listed.account_id, acc);
  assert.equal(listed.category_id, cat);

  // an Excel row cannot be changed or deleted here
  const { rows: [ex] } = await pool.query("INSERT INTO cash_entries (entry_date, amount, amount_amd, category_id, account_id, origin) VALUES ('2026-10-01', 5, 5, $1, $2, 'excel') RETURNING id", [cat, acc]);
  assert.equal((await send("accountant", `/entries/${ex.id}`, "PUT", base)).status, 409);
  assert.equal((await send("accountant", `/entries/${ex.id}`, "DELETE")).status, 409);
  assert.equal((await send("director", `/entries/${made.data.id}`, "DELETE")).status, 403);
  assert.equal((await send("accountant", `/entries/${made.data.id}`, "DELETE")).status, 200);
  assert.equal((await send("accountant", `/entries/${made.data.id}`, "DELETE")).status, 404);

  // a refresh from Excel never touches rows made here
  const kept = await send("accountant", "/entries", "POST", base);
  const before = (await pool.query("SELECT COUNT(*)::int AS n FROM cash_entries WHERE origin = 'manual'")).rows[0].n;
  const { applyCashLedger } = await import("../../src/cashflow.js");
  await applyCashLedger([{ date: "2026-10-02", amount: 1, currency: "AMD", for: "Fuel", source: "Cash ITest2 Z", amount_amd: 1 }], { via: "bot" });
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM cash_entries WHERE origin = 'manual'")).rows[0].n, before);
  assert.ok(await row(kept.data.id));
});

test("edit window, change requests, history with date and time; In / Out counts; several categories; customers list (owner, 2026-10-27)", async () => {
  const send = (who, path, method, body) => apiRequest(`/api/cashflow${path}`, { method, cookie: cookies[who], body });
  const acc = (await send("admin", "/accounts", "POST", { name: `Cash ITest3 ${Date.now()}`, kind: "cash" })).data.id;
  const { rows: [fuel] } = await pool.query("SELECT id FROM cash_categories WHERE lower(name) = 'fuel'");
  const { rows: [oil] } = await pool.query("SELECT id FROM cash_categories WHERE lower(name) = 'oil order'");
  const base = { date: "2032-03-10", direction: "out", amount: 1000, currency: "AMD", account_id: acc, category_id: fuel.id, info: "ITest window" };

  // a fresh row: the accountant edits it directly, and every change is logged with its time and author
  const fresh = (await send("accountant", "/entries", "POST", base)).data.id;
  assert.equal((await send("accountant", `/entries/${fresh}`, "PUT", { ...base, amount: 1500 })).status, 200);
  let d = (await send("accountant", `/entries/${fresh}`, "GET")).data;
  assert.equal(d.right, "now");
  assert.deepEqual(d.log.map((l) => l.action), ["create", "update"]);
  assert.ok(d.log.every((l) => l.at && l.user_name), "date-time and who");
  assert.equal(d.log[1].before.amount, -1000);
  assert.equal(d.log[1].after.amount, -1500);

  // a row older than the window: the accountant can only ask; admin still changes it at once
  const old = (await send("accountant", "/entries", "POST", { ...base, info: "ITest old" })).data.id;
  await pool.query("UPDATE cash_entries SET created_at = now() - interval '4 days' WHERE id = $1", [old]);
  assert.equal((await send("accountant", `/entries/${old}`, "GET")).data.right, "request");
  const blocked = await send("accountant", `/entries/${old}`, "PUT", { ...base, amount: 9 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.needs_request, true);
  assert.equal((await send("accountant", `/entries/${old}`, "DELETE")).status, 409);
  assert.equal((await send("admin", `/entries/${old}`, "GET")).data.right, "now");

  // request -> one waiting at a time -> management sees it -> approve applies it
  const asked = await send("accountant", `/entries/${old}/requests`, "POST", { action: "update", data: { ...base, amount: 7777, info: "ITest old fixed" }, reason: "typo" });
  assert.equal(asked.status, 201);
  assert.equal((await send("accountant", `/entries/${old}/requests`, "POST", { action: "delete" })).status, 409, "one waiting request per row");
  assert.equal((await send("admin", "/meta", "GET")).data.pending_requests >= 1, true);
  const list = (await send("admin", "/requests", "GET")).data;
  assert.equal(list.can_decide, true);
  assert.ok(list.requests.some((r) => r.id === asked.data.id && r.reason === "typo"));
  assert.equal((await send("accountant", `/requests/${asked.data.id}/approve`, "POST", {})).status, 403, "the accountant does not approve");
  assert.equal((await send("ops", `/requests/${asked.data.id}/approve`, "POST", {})).status, 403);
  assert.equal((await send("admin", `/requests/${asked.data.id}/approve`, "POST", {})).status, 200);
  assert.equal((await send("admin", `/requests/${asked.data.id}/approve`, "POST", {})).status, 404, "decided once");
  const { rows: [after] } = await pool.query("SELECT amount::float8 AS amount, info FROM cash_entries WHERE id = $1", [old]);
  assert.deepEqual([after.amount, after.info], [-7777, "ITest old fixed"]);
  d = (await send("accountant", `/entries/${old}`, "GET")).data;
  assert.deepEqual(d.log.map((l) => l.action), ["create", "request", "update", "approve"]);

  // the row changed after the request was made: approving is refused (it would undo that change), the request stays waiting until rejected
  const late = (await send("accountant", `/entries/${old}/requests`, "POST", { action: "update", data: { ...base, amount: 1, info: "ITest stale" } })).data.id;
  assert.equal((await send("admin", `/entries/${old}`, "PUT", { ...base, amount: 7777, info: "ITest old fixed" })).status, 200);
  const refused = await send("admin", `/requests/${late}/approve`, "POST", {});
  assert.equal(refused.status, 409);
  assert.equal((await pool.query("SELECT status FROM cash_entry_requests WHERE id = $1", [late])).rows[0].status, "pending", "nothing half-done");
  assert.equal((await send("admin", `/requests/${late}/reject`, "POST", {})).status, 200);

  // a delete request rejected leaves the row; approved removes it, the history stays readable
  const del = (await send("accountant", `/entries/${old}/requests`, "POST", { action: "delete", reason: "duplicate" })).data.id;
  assert.equal((await send("admin", `/requests/${del}/reject`, "POST", {})).status, 200);
  assert.ok((await pool.query("SELECT 1 FROM cash_entries WHERE id = $1", [old])).rowCount);
  const del2 = (await send("accountant", `/entries/${old}/requests`, "POST", { action: "delete" })).data.id;
  assert.equal((await send("admin", `/requests/${del2}/approve`, "POST", {})).status, 200);
  assert.equal((await pool.query("SELECT 1 FROM cash_entries WHERE id = $1", [old])).rowCount, 0);
  const gone = (await send("admin", `/entries/${old}`, "GET")).data;
  assert.equal(gone.entry, null);
  assert.ok(gone.log.some((l) => l.action === "delete"));

  // In / Out cards: totals and counts follow the other filters, not the card itself; several categories at once
  await send("admin", "/entries", "POST", { ...base, direction: "in", category_id: oil.id, amount: 5000, erp_customer_id: "10001", info: "ITest in" });
  const q = `from=2032-03-01&to=2032-03-31&account=${acc}`;
  const all = (await send("admin", `/entries?${q}`, "GET")).data;
  assert.deepEqual([all.n_in, all.n_out, all.in_amd, all.out_amd], [1, 1, 5000, 1500]);
  const onlyIn = (await send("admin", `/entries?${q}&dir=in&real=1`, "GET")).data;
  assert.equal(onlyIn.entries.length, 1);
  assert.equal(onlyIn.n_out, 1, "the Out count stays while In is tapped");
  assert.equal((await send("admin", `/entries?${q}&categories=${fuel.id},${oil.id}`, "GET")).data.entries.length, 2);
  assert.equal((await send("admin", `/entries?${q}&categories=${fuel.id}`, "GET")).data.entries.length, 1);

  const customers = (await send("accountant", "/customers", "GET")).data.customers;
  assert.ok(Array.isArray(customers));
});
