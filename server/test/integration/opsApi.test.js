// The Claude agents' read-only feed /api/ops/v1 (docs/ops-api.md): token scopes (an ops-read token reaches only the ops feed, Lily's
// accounting token only her API, no token -> 401), GET only, the numbers of /reconcile and /kpi on seeded data, and the privacy rule:
// every response is scanned for name / phone / TIN / address fields and for the seeded people's real names, phones and TINs.
// Isolated (test/isolated-tests.txt): it reads whole-database totals.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, createProduct, loginAs, apiRequest, trackOrder, trackPayment } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { kpiWindows } from "../../src/reports/opsFeed/kpi.js";
import { yerevanToday } from "../../src/utils/yerevanDate.js";

const ERP_ID = "OPS-T-1";
const PROBES = {
  customerName: "Privacy Probe Արտակ",
  legalName: "Privacy Probe Legal LLC",
  erpName: "Privacy ERP Name",
  phone: "+37499123456",
  tin: "09876543",
  address: "Privacy Street 7",
  repName: "Privacy Rep Name",
};
const tokenIds = [];
let adminCookie;
let opsToken;
let lilyToken;

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

test.before(async () => {
  await startTestServer();
  const admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
});
test.after(async () => {
  await pool.query("DELETE FROM erp_order_lines WHERE erp_customer_id = $1", [ERP_ID]);
  await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id = $1", [ERP_ID]);
  await pool.query("DELETE FROM erp_customer_data WHERE erp_customer_id = $1", [ERP_ID]);
  if (tokenIds.length) await pool.query("DELETE FROM integration_tokens WHERE id = ANY($1)", [tokenIds]);
  await cleanupAll();
  await stopTestServer();
});

test("token scopes: ops-read only on /api/ops/v1, accounting only on /api/integration/v1, GET only, no token -> 401", async () => {
  const bad = await apiRequest("/api/integration-tokens", { method: "POST", cookie: adminCookie, body: { name: "x", scope: "root" } });
  assert.equal(bad.status, 400);

  const ops = await apiRequest("/api/integration-tokens", { method: "POST", cookie: adminCookie, body: { name: "Claude agents itest", scope: "ops-read" } });
  assert.equal(ops.status, 201);
  assert.equal(ops.data.scope, "ops-read");
  assert.match(ops.data.token, /^kad_ops_[0-9a-f]{64}$/);
  tokenIds.push(ops.data.id);
  opsToken = ops.data.token;
  // the default stays Lily's scope, so the existing way of issuing her token is unchanged
  const lily = await apiRequest("/api/integration-tokens", { method: "POST", cookie: adminCookie, body: { name: "Lily itest" } });
  assert.equal(lily.status, 201);
  assert.equal(lily.data.scope, "accounting");
  tokenIds.push(lily.data.id);
  lilyToken = lily.data.token;
  const listed = await apiRequest("/api/integration-tokens", { cookie: adminCookie });
  assert.equal(listed.data.find((t) => t.id === ops.data.id).scope, "ops-read");
  assert.ok(listed.data.every((t) => !("token_hash" in t) && !("token" in t)), "the list never shows a token");

  // no token / a bad token / a person's session -> 401
  for (const p of ["/api/ops/v1/reconcile", "/api/ops/v1/kpi", "/api/ops/v1/nothing"]) {
    const r = await apiRequest(p);
    assert.equal(r.status, 401, p);
    assert.equal(r.data.error.code, "unauthorized");
  }
  assert.equal((await apiRequest("/api/ops/v1/kpi", { headers: bearer("kad_ops_nope") })).status, 401);
  assert.equal((await apiRequest("/api/ops/v1/kpi", { cookie: adminCookie })).status, 401, "a session cookie is not an ops token");

  // the wrong scope -> 403, both ways
  const opsOnLily = await apiRequest("/api/integration/v1/orders", { headers: bearer(opsToken) });
  assert.equal(opsOnLily.status, 403);
  assert.equal(opsOnLily.data.error.code, "wrong_scope");
  const opsWriteOnLily = await apiRequest("/api/integration/v1/orders/1/claim", { method: "POST", headers: bearer(opsToken), body: {} });
  assert.equal(opsWriteOnLily.status, 403);
  const lilyOnOps = await apiRequest("/api/ops/v1/kpi", { headers: bearer(lilyToken) });
  assert.equal(lilyOnOps.status, 403);
  assert.equal(lilyOnOps.data.error.code, "wrong_scope");
  assert.equal((await apiRequest("/api/integration/v1/orders", { headers: bearer(lilyToken) })).status, 200, "Lily still works");

  // read-only, unknown paths stop in the feed (never reach Operations control behind it)
  assert.equal((await apiRequest("/api/ops/v1/reconcile", { method: "POST", headers: bearer(opsToken), body: {} })).status, 405);
  assert.equal((await apiRequest("/api/ops/v1/margin", { headers: bearer(opsToken) })).status, 404);
  assert.equal((await apiRequest("/api/ops/v1/kpi?period=year", { headers: bearer(opsToken) })).status, 400);
  assert.equal((await apiRequest("/api/ops/v1/kpi?mode=forever", { headers: bearer(opsToken) })).status, 400);
  // Operations control (a person's session) is untouched by the new mount
  assert.equal((await apiRequest("/api/ops/margin", { cookie: adminCookie })).status, 200);

  // every ops call is in the audit log; the ops token does not make Lily look online on the Accounting tab
  const ok = await apiRequest("/api/ops/v1/reconcile", { headers: bearer(opsToken) });
  assert.equal(ok.status, 200);
  // written after the answer is sent: give it a moment
  let audited = false;
  for (let i = 0; i < 40 && !audited; i++) {
    const { rows } = await pool.query("SELECT 1 FROM integration_audit_log WHERE token_id = $1 AND path = '/api/ops/v1/reconcile' AND status_code = 200", [ops.data.id]);
    audited = rows.length > 0;
    if (!audited) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(audited, "the ops call is in the audit log");
  await pool.query("UPDATE integration_tokens SET last_used_at = NULL WHERE id = $1", [lily.data.id]);
  const agent = await apiRequest("/api/orders/accounting-agent", { cookie: adminCookie });
  assert.equal(agent.data.online, false, "only Lily's own (accounting) token counts as Lily online");

  // revoked -> 401
  const extra = await apiRequest("/api/integration-tokens", { method: "POST", cookie: adminCookie, body: { name: "revoke me", scope: "ops-read" } });
  tokenIds.push(extra.data.id);
  assert.equal((await apiRequest(`/api/integration-tokens/${extra.data.id}`, { method: "DELETE", cookie: adminCookie })).status, 200);
  assert.equal((await apiRequest("/api/ops/v1/kpi", { headers: bearer(extra.data.token) })).status, 401);
});

// --- seeded data: a customer with every kind of personal data, one row the Excel lacks in each module, last week's sales ------------
async function seed() {
  const rep = await createUser("sales_manager", { name: PROBES.repName });
  const customer = await createCustomer({ name: PROBES.customerName, created_by: rep.id, erp_customer_id: ERP_ID });
  await pool.query("UPDATE customers SET phone = $2, tin = $3, address = $4, legal_name = $5, credit_term_days = 30 WHERE id = $1", [
    customer.id,
    PROBES.phone,
    PROBES.tin,
    PROBES.address,
    PROBES.legalName,
  ]);
  const product = await createProduct({ name: "Ops itest oil", unit: "4L" });
  await pool.query("UPDATE products SET erp_product_id = 'OPS-P-1', landing_cost_amd = 6000, stock_qty = 10 WHERE id = $1", [product.id]);
  await pool.query("INSERT INTO erp_customer_data (erp_customer_id, customer_name, debt_amd) VALUES ($1, $2, 300000)", [ERP_ID, PROBES.erpName]);
  // last complete week: 2 orders, 5 x 4 L at 10,000 = 50,000 and 2 x 4 L at 10,000 = 20,000; one of them 120 days ago (overdue)
  const week = kpiWindows("week", "complete", yerevanToday()).current;
  await pool.query(
    `INSERT INTO erp_order_lines (erp_customer_id, order_id, order_date, product_id, product_name, size_l, qty, unit_price_amd, revenue_amd)
     VALUES ($1, 'OPS-O-1', $2, 'OPS-P-1', 'Ops itest oil', '4L', 5, 10000, 50000),
            ($1, 'OPS-O-2', $3, 'OPS-P-1', 'Ops itest oil', '4', 2, 10000, 20000),
            ($1, 'OPS-O-0', (now() - interval '120 days')::date, 'OPS-P-1', 'Ops itest oil', '4', 30, 10000, 300000)`,
    [ERP_ID, week.from, week.to]
  );
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, $2, 15000)", [ERP_ID, week.from]);
  // a cash payment 10 days old the Excel does not have
  const { rows: pay } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, created_by, status)
     VALUES ($1, $2, $3, 12345, $4, $5, $6, $5, 'approved') RETURNING id`,
    [customer.id, PROBES.customerName, ERP_ID, daysAgo(10), rep.id, PROBES.repName]
  );
  trackPayment(pay[0].id);
  // a delivery 9 days old the sync has not found in the Excel
  const { rows: ord } = await pool.query(
    `INSERT INTO orders (customer_id, user_id, status, total_amd, note, created_at, updated_at) VALUES ($1, $2, 'delivered', 40000, $3, $4, $4) RETURNING id`,
    [customer.id, rep.id, `call ${PROBES.phone}`, daysAgo(9)]
  );
  trackOrder(ord[0].id);
}

// every key anywhere in the answer, and the whole text
const FORBIDDEN_KEY = /(^|_)(name|names|phone|phones|tin|address|email|salary|legal|note|notes|comment|purpose|error|rep|manager|user)(_|$)/i;
function assertPseudonymised(label, body) {
  const keys = [];
  (function walk(v, at) {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) keys.push(`${at}.${k}`) && walk(x, `${at}.${k}`);
  })(body, label);
  const bad = keys.filter((k) => FORBIDDEN_KEY.test(k.split(".").pop().replace(/\[\d+\]$/, "")));
  assert.deepEqual(bad, [], `${label}: personal-data fields in the answer`);
  const text = JSON.stringify(body);
  for (const [what, value] of Object.entries(PROBES)) assert.ok(!text.includes(value), `${label}: leaks ${what}`);
  assert.ok(!text.includes(PROBES.phone.slice(4)), `${label}: leaks the phone digits`);
}

test("/reconcile and /kpi: the numbers, ERP ids only, and nothing personal in any answer", async () => {
  await seed();

  const rec = await apiRequest("/api/ops/v1/reconcile", { headers: bearer(opsToken) });
  assert.equal(rec.status, 200);
  assert.equal(rec.data.ok, false);
  assert.equal(rec.data.grace_days, 3);
  const cash = rec.data.modules.cash_payments;
  assert.equal(cash.count, 1);
  assert.equal(cash.amount_amd, 12345);
  assert.equal(cash.oldest_age_days, 10);
  assert.deepEqual(cash.items, [{ customer_erp_id: ERP_ID, kind: "cash_payment_not_in_excel", amount_amd: 12345, age_days: 10 }]);
  const orders = rec.data.modules.orders;
  assert.equal(orders.count, 1);
  assert.deepEqual(orders.items[0], { customer_erp_id: ERP_ID, kind: "order_not_in_excel", amount_amd: 40000, age_days: 9 });
  for (const m of ["bank_payments", "returns", "field_expenses"]) assert.equal(rec.data.modules[m].count, 0, m);
  assert.equal(rec.data.erp_sync.last_success_at, null);
  assert.equal(rec.data.erp_sync.stale, true);
  assert.equal(typeof rec.data.erp_sync.failed_attempts_24h, "number");

  const week = await apiRequest("/api/ops/v1/kpi?period=week", { headers: bearer(opsToken) });
  assert.equal(week.status, 200);
  const cur = week.data.flows.current;
  assert.equal(cur.sales_amd, 70000);
  assert.equal(cur.liters, 28);
  assert.equal(cur.gross_profit_amd, 70000 - 7 * 6000);
  assert.equal(cur.gross_margin_pct, 40);
  assert.equal(cur.cost_coverage_pct, 100);
  assert.equal(cur.orders, 2);
  assert.equal(cur.active_customers, 1);
  assert.equal(cur.collections_amd, 15000);
  assert.equal(week.data.flows.previous.sales_amd, 0);
  assert.equal(week.data.change_pct.vs_previous.sales_amd, null, "no base -> no percent");
  const rcv = week.data.receivables;
  assert.ok(rcv.total_amd >= 300000 + 40000 - 12345 - 1, "live debt = Excel + app delivery - app payment");
  const top = rcv.top_debtors.find((d) => d.customer_erp_id === ERP_ID);
  assert.ok(top, "the seeded debtor is listed by ERP id");
  assert.equal(top.debt_amd, 300000 + 40000 - 12345);
  assert.ok(top.overdue_amd > 0);
  assert.deepEqual(Object.keys(rcv.aging_buckets_amd).sort(), ["d1_30", "d31_60", "d61_90", "d90_plus", "not_due", "opening"]);
  assert.ok(week.data.stock.value_landing_amd >= 60000);
  for (const v of [cur.sales_amd, cur.gross_profit_amd, rcv.total_amd, week.data.stock.value_landing_amd]) assert.ok(Number.isInteger(v), "whole AMD");

  const month = await apiRequest("/api/ops/v1/kpi?period=month&mode=to_date", { headers: bearer(opsToken) });
  assert.equal(month.status, 200);
  assert.equal(month.data.flows.current.from.slice(8), "01");

  for (const [label, body] of [
    ["reconcile", rec.data],
    ["kpi week", week.data],
    ["kpi month", month.data],
  ])
    assertPseudonymised(label, body);
});

test("kpiWindows: the current, previous and last-year windows", () => {
  // Saturday 2026-11-07
  assert.deepEqual(kpiWindows("week", "complete", "2026-11-07"), {
    current: { from: "2026-10-26", to: "2026-11-01" },
    previous: { from: "2026-10-19", to: "2026-10-25" },
    last_year: { from: "2025-10-27", to: "2025-11-02" },
  });
  // on a Monday "to date" is the Monday alone
  assert.deepEqual(kpiWindows("week", "to_date", "2026-11-02").current, { from: "2026-11-02", to: "2026-11-02" });
  assert.deepEqual(kpiWindows("month", "complete", "2026-01-15"), {
    current: { from: "2025-12-01", to: "2025-12-31" },
    previous: { from: "2025-11-01", to: "2025-11-30" },
    last_year: { from: "2024-12-01", to: "2024-12-31" },
  });
  assert.deepEqual(kpiWindows("month", "to_date", "2026-03-31"), {
    current: { from: "2026-03-01", to: "2026-03-31" },
    previous: { from: "2026-02-01", to: "2026-02-28" },
    last_year: { from: "2025-03-01", to: "2025-03-31" },
  });
});
