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
  await pool.query("UPDATE cash_accounts SET account_number = NULL WHERE account_number = '1660000000000100'"); // a crashed earlier run must not leave the number behind
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

// ---- Evoca layout (owner, 2026-11-11): the statement names its own account, proves its own totals ----
import { evocaWorkbook, evocaRows, ACCOUNT } from "../evocaFixture.js";

const evocaForm = async (rows, extra = {}) => {
  const f = new FormData();
  f.append("file", new Blob([await evocaWorkbook(rows)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "evoca.xlsx");
  if (extra.account_id !== undefined) f.append("account_id", String(extra.account_id));
  if (extra.accept_mismatch) f.append("accept_mismatch", "1");
  return f;
};

test("Evoca: the preview shows the statement's own header and checks; no account chosen yet = the person is asked, nothing is saved", async () => {
  const p = await post("/preview", "accountant", await evocaForm(evocaRows()));
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.account_needed, true);
  assert.equal(p.data.account, null);
  assert.equal(p.data.statement.account_number, ACCOUNT);
  assert.equal(p.data.statement.opening_balance, 2200000);
  assert.equal(p.data.total, 5);
  assert.equal(p.data.money_in, 5350000);
  assert.equal(p.data.money_out, 314500);
  assert.equal(p.data.checks.ok, true);
  assert.equal((await post("/import", "accountant", await evocaForm(evocaRows()))).status, 400, "an import needs its account");
});

test("Evoca: the first import teaches the account its number; the next statement finds its account by itself; another account is refused", async () => {
  const first = await post("/import", "accountant", await evocaForm(evocaRows(), { account_id: accountId }));
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.new_lines, 5);
  const { rows: [acc] } = await pool.query("SELECT account_number FROM cash_accounts WHERE id = $1", [accountId]);
  assert.equal(acc.account_number, ACCOUNT);
  const { rows: stored } = await pool.query("SELECT type_code, counterparty_account FROM bank_statement_lines WHERE account_id = $1 AND type_code = 'FEE'", [accountId]);
  assert.equal(stored.length, 1, "the kind of operation is kept");
  const { rows: [imp] } = await pool.query("SELECT statement_meta FROM bank_imports WHERE account_id = $1 ORDER BY id DESC LIMIT 1", [accountId]);
  assert.equal(imp.statement_meta.account_number, ACCOUNT);
  assert.equal(imp.statement_meta.checks.ok, true);

  // found by its number, no account sent
  const again = await post("/preview", "accountant", await evocaForm(evocaRows()));
  assert.equal(again.data.account.id, accountId);
  assert.equal(again.data.account_needed, false);
  assert.equal(again.data.already_imported, 5, "the same statement read again adds nothing");
  // a wrong choice is refused with a clear reason
  const wrong = await post("/preview", "accountant", await evocaForm(evocaRows(), { account_id: otherAccountId }));
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.code, "wrong_account");
  assert.match(wrong.data.error, new RegExp(ACCOUNT));
});

test("Evoca: lines that do not add up to the statement's own totals are refused unless the accountant accepts the difference", async () => {
  const broken = evocaRows();
  broken.splice(12, 1);
  const refused = await post("/import", "accountant", await evocaForm(broken, { account_id: accountId }));
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, "totals_mismatch");
  assert.ok(refused.data.checks.items.length > 0);
  const accepted = await post("/import", "accountant", await evocaForm(broken, { account_id: accountId, accept_mismatch: true }));
  assert.equal(accepted.status, 201, JSON.stringify(accepted.data));
  const { rows: [imp] } = await pool.query("SELECT statement_meta FROM bank_imports WHERE account_id = $1 ORDER BY id DESC LIMIT 1", [accountId]);
  assert.equal(imp.statement_meta.accepted_mismatch, true, "the audit trail says it was accepted");
});

test("Evoca: an AMD statement is refused in a USD account, and an account with another saved number refuses this statement", async () => {
  const usd = (await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'bank') RETURNING id", [`ITEST Bank USD ${Date.now()}`])).rows[0].id;
  const numbered = (await pool.query("INSERT INTO cash_accounts (name, kind, account_number) VALUES ($1, 'bank', 'OTHER-NUMBER-1') RETURNING id", [`ITEST Numbered ${Date.now()}`])).rows[0].id;
  try {
    const noNumber = evocaRows();
    noNumber[2] = ["Հաշիվ N", "", "x"]; // a statement that does not name its account: only the currency can tell
    const wrongCurrency = await post("/preview", "accountant", await evocaForm(noNumber, { account_id: usd }));
    assert.equal(wrongCurrency.status, 400);
    assert.equal(wrongCurrency.data.code, "wrong_account");
    assert.match(wrongCurrency.data.error, /AMD/);
    const otherNumber = await post("/import", "accountant", await evocaForm(evocaRows(), { account_id: numbered }));
    assert.equal(otherNumber.status, 400);
    assert.equal(otherNumber.data.code, "wrong_account");
  } finally {
    await pool.query("DELETE FROM cash_accounts WHERE id = ANY($1)", [[usd, numbered]]);
  }
});

// ---- the check against the accountant's Excel rows, and learning from them (owner, 2026-11-11) ----
test("check: statement lines against the Cashflow rows the accountant already booked: matched, missing in Excel, Excel only, near misses; matches teach the categories", async () => {
  const cat = async (name) => (await pool.query("SELECT id FROM cash_categories WHERE name = $1", [name])).rows[0].id;
  const [oil, other, salary, transfer] = await Promise.all([cat("Oil order"), cat("Other"), cat("Salary"), cat("Transfer")]);
  await pool.query("DELETE FROM bank_category_rules WHERE key LIKE 'cp:%տեստ%'");
  await post("/import", "accountant", await evocaForm(evocaRows(), { account_id: accountId })); // (already imported by an earlier test: no new lines)
  const book = (date, amount, category, info = null) =>
    pool.query("INSERT INTO cash_entries (entry_date, amount, amount_amd, account_id, category_id, info, origin) VALUES ($1, $2, $2, $3, $4, $5, 'excel')", [date, amount, accountId, category, info]);
  await book("2026-10-01", 1000000, oil, "Customer A"); // a payment, same day
  await book("2026-10-02", 350000, oil); // the next day: still the same transaction
  await book("2026-10-01", -5500, other); // the bank's fee
  await book("2026-10-10", -309000, salary); // the salary booked 8 days late: a near miss
  await book("2026-10-02", -10000, other); // booked by mistake: no bank line
  const c = (await apiRequest(`/api/cashflow/bank/check?account=${accountId}`, { cookie: cookies.accountant })).data;
  assert.equal(c.period.from, "2026-10-01");
  assert.equal(c.counts.lines >= 5, true);
  assert.equal(c.counts.near, 1, JSON.stringify(c.near.map((n) => [n.line.amount, n.days])));
  assert.equal(c.near[0].line.amount, -309000);
  assert.equal(c.near[0].days, 8);
  assert.ok(c.excel_only.some((e) => e.amount === -10000), "the row with no bank line is listed");
  assert.ok(c.missing_in_excel.some((l) => l.amount === 4000000), "the transfer nobody booked is missing in Excel");
  // matched lines taught the rules: the same payer's next line is suggested the accountant's category
  const { rows: rules } = await pool.query("SELECT key, category_id, hits FROM bank_category_rules WHERE key LIKE 'cp:%տեստ հաճախորդ%|in'");
  assert.equal(rules.length, 1);
  assert.equal(rules[0].category_id, oil);
  await pool.query(
    `INSERT INTO bank_statement_lines (account_id, line_date, amount, currency, description, counterparty, reference, line_hash, type_code, counterparty_account)
     VALUES ($1, '2026-11-02', 70000, 'AMD', 'Payment', '«ՏԵՍՏ ՀԱՃԱԽՈՐԴ» ՍՊԸ', 'R1', $2, 'TRF', '1570000000000100')`,
    [accountId, `learn-${Date.now()}`]
  );
  // built-in rules need no history: a transfer from one of OUR accounts, a salary
  await pool.query(
    `INSERT INTO bank_statement_lines (account_id, line_date, amount, currency, description, counterparty, reference, line_hash, type_code, counterparty_account)
     VALUES ($1, '2026-11-03', 500000, 'AMD', 'Փոխանցում', 'OWN', 'R2', $3, 'TRF', $2), ($1, '2026-11-03', -120000, 'AMD', 'աշխատավարձ', 'ՏԵՍՏ ԱՇԽԱՏԱԿԻՑ 2', 'R3', $4, 'TRF', '999')`,
    [otherAccountId, "1660000000000100", `own-${Date.now()}`, `sal-${Date.now()}`]
  );
  const mine = (await apiRequest(`/api/cashflow/bank/lines?account=${accountId}&state=unmatched`, { cookie: cookies.accountant })).data.lines.find((l) => l.amount === 70000);
  assert.equal(mine.suggested_category_id, oil);
  assert.equal(mine.suggested_reason, "learned:cp");
  const other2 = (await apiRequest(`/api/cashflow/bank/lines?account=${otherAccountId}&state=unmatched`, { cookie: cookies.accountant })).data.lines;
  assert.equal(other2.find((l) => l.amount === 500000).suggested_category_id, transfer);
  assert.equal(other2.find((l) => l.amount === 500000).suggested_reason, "own_account");
  assert.equal(other2.find((l) => l.amount === -120000).suggested_category_id, salary);
  await pool.query("DELETE FROM bank_category_rules WHERE key LIKE 'cp:%տեստ%'");
});
