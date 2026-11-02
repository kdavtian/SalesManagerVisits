// Payments, redesigned -- release 2: cash desks (several holders, admin edits, every rep gets his own) and bank payments (typed by hand or
// read from an uploaded statement; the same money never twice; Unspecified for what the app cannot decide). Owner, 2026-11-02.
// Isolated (test/isolated-tests.txt): it moves the payments cutover and the statement check acts on every new line.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, apiFormRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { recordBankLines } from "../../src/money/payments2/bankPayments.js";

const RUN = Date.now().toString(36);
const dayAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const dmy = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const TIN_A = `9${String(Date.now()).slice(-7)}`;
let users, cookies, shopA, shopB, shopC, bankId, oldCutover;
const apiUsers = [];
const desks = [];

const csv = (rows, header = "Date;Payer;Description;Debit;Credit") => [header, ...rows].join("\n");
const upload = (text, name = "stmt.csv", who = "accountant") => {
  const f = new FormData();
  f.append("file", new Blob([text], { type: "text/csv" }), name);
  f.append("account_id", String(bankId));
  return apiFormRequest("/api/cashflow/bank/import", { form: f, cookie: cookies[who] });
};
const paymentsOf = async (customerId) => (await pool.query("SELECT * FROM customer_payments WHERE customer_id = $1 ORDER BY id", [customerId])).rows;
const unspecified = async () => (await apiRequest("/api/payments2/bank/unspecified", { cookie: cookies.accountant })).data;

test.before(async () => {
  await startTestServer();
  users = {};
  cookies = {};
  for (const role of ["admin", "accountant", "sales_manager", "sales_director", "ceo"]) {
    users[role] = await createUser(role, { name: `ITest ${role} ${RUN}` });
    cookies[role] = await loginAs(users[role].email);
  }
  shopA = await createCustomer({ created_by: users.sales_manager.id, name: `ITest Shop A ${RUN}` });
  shopB = await createCustomer({ created_by: users.sales_manager.id, name: `ITest Auto Mas ${RUN}` });
  shopC = await createCustomer({ created_by: users.sales_manager.id, name: `ITest Shop C ${RUN}` });
  await pool.query("UPDATE customers SET tin = $2, erp_customer_id = $3 WHERE id = $1", [shopA.id, TIN_A, `ITA${RUN}`]);
  await pool.query("UPDATE customers SET legal_name = $2 WHERE id = $1", [shopB.id, `«ITest Auto Mas ${RUN}» ՍՊԸ`]);
  oldCutover = (await pool.query("SELECT to_char(payments_cutover, 'YYYY-MM-DD') AS d FROM app_settings WHERE id = 1")).rows[0].d;
  await pool.query("UPDATE app_settings SET payments_cutover = $1 WHERE id = 1", [dayAgo(20)]);
  bankId = (await pool.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, 'bank') RETURNING id", [`ITest Bank ${RUN}`])).rows[0].id;
  // lines other files left unchecked are not this file's business
  await recordBankLines(pool);
});

test.after(async () => {
  const shops = [shopA.id, shopB.id, shopC.id];
  await pool.query("DELETE FROM customer_payments WHERE customer_id = ANY($1)", [shops]);
  await pool.query("DELETE FROM bank_payers WHERE customer_id = ANY($1) OR payer_key LIKE $2", [shops, `%${RUN.toLowerCase()}%`]);
  await pool.query("DELETE FROM bank_statement_lines WHERE account_id = $1", [bankId]);
  await pool.query("DELETE FROM bank_imports WHERE account_id = $1", [bankId]);
  try {
    const auto = (await pool.query("SELECT id FROM cash_accounts WHERE auto_for_user_id = ANY($1)", [[...apiUsers, users.sales_manager.id]])).rows.map((r) => r.id);
    const accounts = [bankId, ...desks, ...auto];
    await pool.query("DELETE FROM cash_entries WHERE account_id = ANY($1)", [accounts]);
    await pool.query("DELETE FROM cash_accounts WHERE id = ANY($1)", [accounts]);
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [apiUsers]);
    await pool.query("UPDATE app_settings SET payments_cutover = $1 WHERE id = 1", [oldCutover]);
    await cleanupAll();
  } finally {
    await stopTestServer();
  }
});

test("cash desks: admin adds a desk with several holders, a rename keeps the Excel name, only admin and CEO edit", async () => {
  const made = await apiRequest("/api/payments2/desks", { method: "POST", cookie: cookies.admin, body: { name: `ITest Office desk ${RUN}`, holder_ids: [users.accountant.id, users.ceo.id] } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  desks.push(made.data.desk.id);
  assert.deepEqual(made.data.desk.holders.map((h) => h.id).sort(), [users.accountant.id, users.ceo.id].sort());
  const renamed = await apiRequest(`/api/payments2/desks/${made.data.desk.id}`, { method: "PATCH", cookie: cookies.admin, body: { name: `ITest Office ${RUN}` } });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.data.desk.excel_aliases, [`ITest Office desk ${RUN}`]);
  // the Excel import still lands on the desk by its old name
  const { applyCashLedger } = await import("../../src/money/cashflow.js");
  await applyCashLedger([{ date: dayAgo(1), amount: 1, currency: "AMD", for: "Fuel", source: `ITest Office desk ${RUN}`, amount_amd: 1 }], { via: "bot" });
  const { rows: landed } = await pool.query("SELECT account_id FROM cash_entries WHERE origin = 'excel' AND entry_date = $1 AND amount = 1", [dayAgo(1)]);
  assert.ok(landed.some((r) => r.account_id === made.data.desk.id));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cash_accounts WHERE lower(name) = lower($1)", [`ITest Office desk ${RUN}`])).rows[0].n, 0, "no second account");
  // the accountant sees the desks but cannot change them; a rep cannot even read them
  assert.equal((await apiRequest("/api/payments2/desks", { cookie: cookies.accountant })).status, 200);
  assert.equal((await apiRequest(`/api/payments2/desks/${made.data.desk.id}`, { method: "PATCH", cookie: cookies.accountant, body: { name: "x y" } })).status, 403);
  assert.equal((await apiRequest("/api/payments2/desks", { cookie: cookies.sales_manager })).status, 403);
  // the CEO edits desks too (owner, 2026-11-02)
  assert.equal((await apiRequest(`/api/payments2/desks/${made.data.desk.id}`, { method: "PATCH", cookie: cookies.ceo, body: { holder_ids: [users.accountant.id, users.ceo.id, users.admin.id] } })).status, 200);
});

test("every new sales rep gets his own desk, and so does a person made a rep", async () => {
  const email = `itest-rep-${RUN}@kadmotors.local`;
  const created = await apiRequest("/api/users", { method: "POST", cookie: cookies.admin, body: { email, password: "TestPass123!", name: `ITest Rep ${RUN}`, role: "sales_manager" } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  apiUsers.push(created.data.id);
  const desk = (await pool.query("SELECT a.name FROM cash_desk_holders h JOIN cash_accounts a ON a.id = h.account_id WHERE h.user_id = $1", [created.data.id])).rows;
  assert.deepEqual(desk.map((d) => d.name), [`SM ITest Rep ${RUN} desk`]);
  const email2 = `itest-wh-${RUN}@kadmotors.local`;
  const other = await apiRequest("/api/users", { method: "POST", cookie: cookies.admin, body: { email: email2, password: "TestPass123!", name: `ITest Later ${RUN}`, role: "warehouse_manager" } });
  apiUsers.push(other.data.id);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cash_desk_holders WHERE user_id = $1", [other.data.id])).rows[0].n, 0, "only reps get one");
  assert.equal((await apiRequest(`/api/users/${other.data.id}/role`, { method: "PATCH", cookie: cookies.admin, body: { role: "sales_manager" } })).status, 200);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM cash_desk_holders WHERE user_id = $1", [other.data.id])).rows[0].n, 1);
});

test("a statement: TIN and exact name are recorded, an unknown payer waits, money out is ignored, reading it again adds nothing", async () => {
  const text = csv([
    `${dmy(dayAgo(3))};Some Firm;Oil, ՀՎՀՀ ${TIN_A};;50 000,00`,
    `${dmy(dayAgo(3))};ITEST AUTO MAS ${RUN} LLC;invoice 12;;30 000,00`,
    `${dmy(dayAgo(2))};Stranger ${RUN};payment;;20 000,00`,
    `${dmy(dayAgo(2))};Fuel;fuel;5 000,00;`,
    `${dmy(dayAgo(40))};Old Firm;ՀՎՀՀ ${TIN_A};;99 000,00`,
  ]);
  const r = await upload(text);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.payments.recorded, 2);
  assert.equal(r.data.payments.unspecified, 1);
  const a = await paymentsOf(shopA.id);
  assert.equal(a.length, 1, "the line before the cutover is not a new payment");
  assert.equal(Number(a[0].amount_amd), 50000);
  assert.equal(a[0].payer_match, "tin");
  assert.equal(a[0].source, "bank");
  assert.equal(a[0].account_id, bankId);
  assert.equal((await paymentsOf(shopB.id))[0].payer_match, "name");
  const again = await upload(text);
  assert.equal(again.data.new_lines, 0);
  assert.deepEqual(again.data.payments, { recorded: 0, confirmed: 0, unspecified: 0, skipped: 0 });
  assert.equal((await paymentsOf(shopA.id)).length, 1);
  const u = await unspecified();
  assert.ok(u.lines.some((l) => l.counterparty === `Stranger ${RUN}` && l.reason === "unknown_payer" && l.amount === 20000));
});

test("typed by hand, then the statement: one payment (the line confirms it); typing it again is refused until 'separate'", async () => {
  const body = { customer_id: shopC.id, amount: 70000, day: dayAgo(2), account_id: bankId, method: "bank", client_ref: `c1-${RUN}` };
  const typed = await apiRequest("/api/payments2/bank/payments", { method: "POST", cookie: cookies.accountant, body });
  assert.equal(typed.status, 201, JSON.stringify(typed.data));
  // a retry of the same request (lost answer) gives the same payment
  const retry = await apiRequest("/api/payments2/bank/payments", { method: "POST", cookie: cookies.accountant, body });
  assert.equal(retry.data.payment.id, typed.data.payment.id);
  // the payer is new: the accountant points the line to the customer, which confirms the typed payment instead of adding one
  await upload(csv([`${dmy(dayAgo(1))};Payer C ${RUN};for oil;;70 000,00`]), "c.csv");
  const line = (await unspecified()).lines.find((l) => l.counterparty === `Payer C ${RUN}`);
  assert.ok(line);
  const resolved = await apiRequest(`/api/payments2/bank/lines/${line.id}/resolve`, { method: "POST", cookie: cookies.accountant, body: { action: "customer", customer_id: shopC.id } });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
  assert.equal(resolved.data.confirmed, true);
  const c = await paymentsOf(shopC.id);
  assert.equal(c.length, 1);
  assert.equal(c[0].bank_line_id, line.id);
  // next time the same payer is recorded on its own (remembered)
  const next = await upload(csv([`${dmy(dayAgo(1))};PAYER C ${RUN};again;;15 000,00`]), "c2.csv");
  assert.equal(next.data.payments.recorded, 1);
  assert.equal((await paymentsOf(shopC.id)).at(-1).payer_match, "learned");
  // typing the 70,000 again
  const dup = await apiRequest("/api/payments2/bank/payments", { method: "POST", cookie: cookies.accountant, body: { ...body, client_ref: `c2-${RUN}` } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.duplicates[0].id, typed.data.payment.id);
  const separate = await apiRequest("/api/payments2/bank/payments", { method: "POST", cookie: cookies.accountant, body: { ...body, client_ref: `c3-${RUN}`, separate: true } });
  assert.equal(separate.status, 201);
  // a future date, a date before the cutover, a cash desk as the account: refused
  for (const bad of [{ day: dayAgo(-2) }, { day: dayAgo(30) }, { account_id: desks[0] }]) {
    assert.equal((await apiRequest("/api/payments2/bank/payments", { method: "POST", cookie: cookies.accountant, body: { ...body, client_ref: null, separate: true, ...bad } })).status, 400, JSON.stringify(bad));
  }
});

test("not a customer is remembered; a second copy of a recorded line waits as a possible duplicate", async () => {
  await upload(csv([`${dmy(dayAgo(1))};POS settlement ${RUN};cards;;12 345,00`]), "pos.csv");
  const pos = (await unspecified()).lines.find((l) => l.counterparty === `POS settlement ${RUN}`);
  assert.equal((await apiRequest(`/api/payments2/bank/lines/${pos.id}/resolve`, { method: "POST", cookie: cookies.accountant, body: { action: "not_customer" } })).status, 200);
  const nextPos = await upload(csv([`${dmy(dayAgo(0))};POS settlement ${RUN};cards;;8 000,00`]), "pos2.csv");
  assert.equal(nextPos.data.payments.unspecified, 0);
  assert.equal(nextPos.data.payments.skipped, 1);
  // the TIN line of shop A again, exported in another format (other columns): another hash, the same money
  const copy = await upload(csv([`${dmy(dayAgo(3))};Some Firm;50000;Oil payment ՀՎՀՀ ${TIN_A}`], "Date;Payer;Credit;Description"), "other-format.csv");
  assert.equal(copy.data.new_lines, 1);
  assert.equal(copy.data.payments.unspecified, 1);
  assert.equal((await paymentsOf(shopA.id)).length, 1);
  const waiting = (await unspecified()).lines.find((l) => l.reason === "possible_copy" && l.customer_id === shopA.id);
  assert.ok(waiting?.copy_of?.payment_id);
  assert.equal((await apiRequest(`/api/payments2/bank/lines/${waiting.id}/resolve`, { method: "POST", cookie: cookies.accountant, body: { action: "duplicate" } })).status, 200);
  assert.equal((await paymentsOf(shopA.id)).length, 1);
  // a wrong tap is undone (the toast's Undo): the line waits again; deciding a decided line is refused
  assert.equal((await apiRequest(`/api/payments2/bank/lines/${waiting.id}/resolve`, { method: "POST", cookie: cookies.accountant, body: { action: "reopen" } })).status, 200);
  assert.ok((await unspecified()).lines.some((l) => l.id === waiting.id));
  assert.equal((await apiRequest(`/api/payments2/bank/lines/${waiting.id}/resolve`, { method: "POST", cookie: cookies.accountant, body: { action: "duplicate" } })).status, 409, "only a possible copy is a duplicate");
  assert.equal((await apiRequest(`/api/payments2/bank/lines/${waiting.id}/resolve`, { method: "POST", cookie: cookies.accountant, body: { action: "not_customer", remember: false } })).status, 200);
});

test("a payment found for the wrong customer moves (with a reason); voiding a bank payment puts its line back in Unspecified", async () => {
  const [b] = await paymentsOf(shopB.id);
  assert.equal((await apiRequest(`/api/payments2/${b.id}/customer`, { method: "POST", cookie: cookies.accountant, body: { customer_id: shopC.id, reason: "" } })).status, 400);
  const moved = await apiRequest(`/api/payments2/${b.id}/customer`, { method: "POST", cookie: cookies.accountant, body: { customer_id: shopC.id, reason: "branch of C" } });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.payment.customer_id, shopC.id);
  // a bank payment is voided by admin / CEO only (owner's answer 7)
  assert.equal((await apiRequest(`/api/payments2/${b.id}/void`, { method: "POST", cookie: cookies.accountant, body: { reason: "not ours" } })).status, 403);
  assert.equal((await apiRequest(`/api/payments2/${b.id}/void`, { method: "POST", cookie: cookies.admin, body: { reason: "not ours" } })).status, 200);
  const line = (await pool.query("SELECT pay_state FROM bank_statement_lines WHERE id = $1", [b.bank_line_id])).rows[0];
  assert.equal(line.pay_state, "unspecified");
});

test("roles: a rep and the sales director cannot touch bank payments; the list shows them to the accountant", async () => {
  for (const who of ["sales_manager", "sales_director"]) {
    assert.equal((await apiRequest("/api/payments2/bank/unspecified", { cookie: cookies[who] })).status, 403, who);
    assert.equal((await apiRequest("/api/payments2/bank/payments", { method: "POST", cookie: cookies[who], body: {} })).status, 403, who);
    assert.equal((await apiRequest("/api/payments2/setup", { cookie: cookies[who] })).status, 403, who);
  }
  const list = await apiRequest("/api/payments2/bank/payments", { cookie: cookies.ceo });
  assert.equal(list.status, 200);
  assert.ok(list.data.payments.some((p) => p.customer_id === shopA.id && p.line?.counterparty === "Some Firm"));
  const setup = await apiRequest("/api/payments2/setup", { cookie: cookies.accountant });
  assert.ok(setup.data.bank_accounts.some((a) => a.id === bankId));
  assert.equal(setup.data.can_manage_desks, false);
});
