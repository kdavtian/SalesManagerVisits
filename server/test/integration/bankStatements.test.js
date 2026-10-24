// Bank statements (Cashflow phase 3): upload, no double import, reconciliation with the ledger, add / ignore / reopen, roles.
// Works on its own bank account (created here, removed after) so the real ledger is never touched.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, apiFormRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let accountant, director, cookies, accountId, otherAccountId, categoryId;
const CSV = [
  "Date;Description;Debit;Credit",
  "01.10.2026;Paid by customer ABC;;150 000,00",
  "02.10.2026;Fuel station;20 000,00;",
  "03.10.2026;Bank fee;500,00;",
  "03.10.2026;Bank fee;500,00;",
].join("\n");

test.before(async () => {
  await startTestServer();
  accountant = await createUser("accountant");
  director = await createUser("sales_director");
  cookies = { accountant: await loginAs(accountant.email), director: await loginAs(director.email) };
  accountId = (await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'bank') RETURNING id", [`ITEST Bank ${Date.now()}`])).rows[0].id;
  otherAccountId = (await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'bank') RETURNING id", [`ITEST Other ${Date.now()}`])).rows[0].id;
  categoryId = (await pool.query("SELECT id FROM cash_categories WHERE name = 'Fuel'")).rows[0].id;
  // the ledger already has the customer's payment (a day off from the bank) and the fuel row (manual rows: a parallel Excel refresh must not delete them)
  const ins = (date, amount, origin = "manual") => pool.query("INSERT INTO cash_entries (entry_date, amount, amount_amd, account_id, category_id, origin) VALUES ($1, $2, $2, $3, $4, $5)", [date, amount, accountId, categoryId, origin]);
  await ins("2026-10-02", 150000);
  await ins("2026-10-02", -20000);
});
test.after(async () => {
  await pool.query("DELETE FROM cash_entries WHERE account_id = ANY($1)", [[accountId, otherAccountId]]);
  await pool.query("DELETE FROM cash_accounts WHERE id = ANY($1)", [[accountId, otherAccountId]]);
  await cleanupAll();
  await stopTestServer();
});

const form = (extra = {}, csv = CSV, name = "stmt.csv") => {
  const f = new FormData();
  f.append("file", new Blob([csv], { type: "text/csv" }), name);
  f.append("account_id", String(extra.account_id ?? accountId));
  if (extra.mapping) f.append("mapping", JSON.stringify(extra.mapping));
  return f;
};
const post = (path, who, f) => apiFormRequest(`/api/cashflow/bank${path}`, { form: f, cookie: cookies[who] });
const lines = async (q = "") => (await apiRequest(`/api/cashflow/bank/lines?account=${accountId}${q}`, { cookie: cookies.accountant })).data;

test("only the Cashflow editors upload; a sales director cannot even read", async () => {
  assert.equal((await post("/preview", "director", form())).status, 403);
  assert.equal((await apiRequest("/api/cashflow/bank/lines", { cookie: cookies.director })).status, 403);
});

test("preview reads the file and imports nothing; a bad account or no file is a clear 400", async () => {
  const p = await post("/preview", "accountant", form());
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.total, 4);
  assert.equal(p.data.already_imported, 0);
  assert.equal(p.data.first_date, "2026-10-01");
  assert.equal((await lines()).total, 0);
  assert.equal((await post("/preview", "accountant", form({ account_id: 999999999 }))).status, 400);
  const empty = new FormData();
  empty.append("account_id", String(accountId));
  assert.equal((await post("/preview", "accountant", empty)).status, 400);
});

test("import keeps the lines, matches the ledger rows within 3 days, never imports twice", async () => {
  const r = await post("/import", "accountant", form());
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.new_lines, 4);
  assert.equal(r.data.duplicate_lines, 0);
  assert.equal(r.data.matched, 2, "the payment (a day apart) and the fuel row found their Excel rows");
  assert.equal(r.data.unmatched, 2, "the two bank fees have no row yet");
  const again = await post("/import", "accountant", form());
  assert.equal(again.data.new_lines, 0);
  assert.equal(again.data.duplicate_lines, 4);
  const all = await lines();
  assert.equal(all.total, 4);
  assert.deepEqual(all.counts, { matched: 2, unmatched: 2, added: 0, ignored: 0 });
  // the same statement for another account is a different set of lines
  assert.equal((await post("/import", "accountant", form({ account_id: otherAccountId }))).data.new_lines, 4);
  // the ledger list marks the rows the bank confirmed
  const entries = (await apiRequest(`/api/cashflow/entries?account=${accountId}&limit=50`, { cookie: cookies.accountant })).data.entries;
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.bank_ok === true));
});

test("a line without a row: add it as a manual row (then it is never added twice) or ignore it, and reopen an ignored one", async () => {
  const unmatched = (await lines("&state=unmatched")).lines;
  assert.equal(unmatched.length, 2);
  const [a, b] = unmatched;
  assert.equal((await apiRequest(`/api/cashflow/bank/lines/${a.id}/add`, { method: "POST", cookie: cookies.accountant, body: {} })).status, 400, "a category is needed");
  const added = await apiRequest(`/api/cashflow/bank/lines/${a.id}/add`, { method: "POST", cookie: cookies.accountant, body: { category_id: categoryId } });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const { rows: [entry] } = await pool.query("SELECT amount::float8 AS amount, origin, account_id, info FROM cash_entries WHERE id = $1", [added.data.entry_id]);
  assert.deepEqual([entry.amount, entry.origin, entry.account_id], [-500, "bank", accountId]);
  assert.match(entry.info, /Bank fee/);
  assert.equal((await apiRequest(`/api/cashflow/bank/lines/${a.id}/add`, { method: "POST", cookie: cookies.accountant, body: { category_id: categoryId } })).status, 409);

  assert.equal((await apiRequest(`/api/cashflow/bank/lines/${b.id}/ignore`, { method: "POST", cookie: cookies.accountant })).status, 200);
  assert.deepEqual((await lines()).counts, { matched: 2, unmatched: 0, added: 1, ignored: 1 });
  assert.equal((await apiRequest(`/api/cashflow/bank/lines/${b.id}/reopen`, { method: "POST", cookie: cookies.accountant })).status, 200);
  assert.equal((await lines()).counts.unmatched, 1);
  assert.equal((await apiRequest(`/api/cashflow/bank/lines/${a.id}/reopen`, { method: "POST", cookie: cookies.accountant })).status, 409, "an added line cannot be reopened");
});

test("an Excel row that appears later turns the line into a match by itself", async () => {
  const before = await lines("&state=unmatched");
  assert.equal(before.total, 1);
  await pool.query("INSERT INTO cash_entries (entry_date, amount, amount_amd, account_id, category_id, origin) VALUES ('2026-10-03', -500, -500, $1, $2, 'manual')", [accountId, categoryId]);
  const after = await lines();
  assert.equal(after.counts.unmatched, 0);
  assert.equal(after.counts.matched, 3);
});

test("a statement with unknown columns needs a mapping; with one it imports", async () => {
  const csv = "foo;bar;baz\n2026-11-01;Odd payment;777\n";
  const first = await post("/preview", "accountant", form({}, csv));
  assert.equal(first.data.needs_mapping, true);
  assert.equal((await post("/import", "accountant", form({}, csv))).status, 400);
  const ok = await post("/import", "accountant", form({ mapping: { date: 0, description: 1, amount: 2 } }, csv));
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.new_lines, 1);
});
