// Owner, 2026-11-03: frozen credit. NET debt = live debt - frozen (never below 0) everywhere; papers for the customer stay gross.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { netDebt, frozenApplied } from "../../src/shared/netDebt.js";
import { evaluateCredit } from "../../src/orders/creditLimit.js";
import { liveDebtMap } from "../../src/money/liveDebt.js";

const ERP = `FZ${Date.now().toString(36)}`;
let admin, acct, rep, adminCookie, acctCookie, repCookie, customer;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  acct = await createUser("accountant");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  acctCookie = await loginAs(acct.email);
  customer = await createCustomer({ created_by: rep.id, erp_customer_id: ERP });
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd, synced_at) VALUES ($1, 'x', 100000, now())", [ERP]);
  await pool.query("UPDATE customers SET credit_limit_amd = 150000 WHERE id = $1", [customer.id]);
});
test.after(async () => {
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [ERP]);
  await cleanupAll();
  await stopTestServer();
});

test("netDebt: frozen lowers a debt, never below 0, never touches an advance", () => {
  assert.equal(netDebt(100000, 0), 100000);
  assert.equal(netDebt(100000, 30000), 70000);
  assert.equal(netDebt(100000, 250000), 0);
  assert.equal(netDebt(-5000, 30000), -5000);
  assert.equal(frozenApplied(100000, 250000), 100000);
  assert.equal(frozenApplied(-5000, 30000), 0);
});

test("only the accountant / directors set it; a sales rep cannot", async () => {
  const no = await apiRequest(`/api/customers/${customer.id}/credit-terms`, { method: "PUT", cookie: repCookie, body: { credit_limit_amd: 150000, frozen_credit_amd: 40000 } });
  assert.equal(no.status, 403);
  const bad = await apiRequest(`/api/customers/${customer.id}/credit-terms`, { method: "PUT", cookie: adminCookie, body: { credit_limit_amd: 150000, frozen_credit_amd: -1 } });
  assert.equal(bad.status, 400);
  const ok = await apiRequest(`/api/customers/${customer.id}/credit-terms`, { method: "PUT", cookie: acctCookie, body: { credit_limit_amd: 150000, frozen_credit_amd: 40000 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.frozen_credit_amd, 40000);
  const { rows } = await pool.query("SELECT old_amount::float8 AS o, new_amount::float8 AS n FROM customer_frozen_credit_log WHERE customer_id = $1", [customer.id]);
  assert.deepEqual(rows, [{ o: 0, n: 40000 }]);
});

test("the customer card shows the net debt and the frozen line", async () => {
  const r = await apiRequest(`/api/customers/${customer.id}`, { cookie: adminCookie });
  assert.equal(r.data.live_debt.debt_amd, 60000);
  assert.equal(r.data.live_debt.frozen_amd, 40000);
  assert.equal(r.data.live_debt.gross_debt_amd, 100000);
});

test("the order credit check counts the NET debt only", async () => {
  // limit 150,000: net 60,000 + order 80,000 = 140,000 fits; with nothing frozen 100,000 + 80,000 = 180,000 would not
  const fit = await evaluateCredit(pool, customer.id, 80000);
  assert.equal(fit.debt, 60000);
  assert.equal(fit.exceeded, false);
  await pool.query("UPDATE customers SET frozen_credit_amd = 0 WHERE id = $1", [customer.id]);
  const over = await evaluateCredit(pool, customer.id, 80000);
  assert.equal(over.exceeded, true);
  await pool.query("UPDATE customers SET frozen_credit_amd = 40000 WHERE id = $1", [customer.id]);
});

test("jobs and reports read the net debt; a paper for the customer reads the gross", async () => {
  const row = { id: customer.id, erp_customer_id: ERP, debt_amd: 100000, credit_term_days: 45 };
  const net = (await liveDebtMap(pool, [row], "2026-11-03")).get(customer.id);
  assert.equal(net.debt_amd, 60000);
  const gross = (await liveDebtMap(pool, [row], "2026-11-03", { gross: true })).get(customer.id);
  assert.equal(gross.debt_amd, 100000);
});

test("the Debt balances list shows the net debt with the frozen line", async () => {
  const list = await apiRequest("/api/debt-balances", { cookie: adminCookie });
  const r = list.data.rows.find((x) => x.internal_customer_id === customer.id);
  assert.equal(Number(r.remaining_balance), 60000);
  assert.equal(r.frozen_amd, 40000);
});
