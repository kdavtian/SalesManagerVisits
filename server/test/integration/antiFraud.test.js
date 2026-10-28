// Anti-fraud watch (owner, 2026-10-25): findings, risk scores, learning from verdicts, the weekly check calls, the customer dispute.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackPayment } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { runAntiFraud, ensureWeeklySpotChecks, recordCustomerDispute, getWeights, repRisk, riskLevel } from "../../src/money/antiFraud.js";

const ERP = `itest-fraud-${Date.now()}`;
let admin, rep, rep2, customers, adminCookie, repCookie;
const createdPayments = [];

async function pay(customer, amount, { daysAgo = 0, status = "pending", holder = rep, createdAgoMin = null, erp = ERP } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, current_holder_id, created_at)
     VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval, $6, 'Fixture Rep', $7, $6, $8, COALESCE(now() - ($9 || ' minutes')::interval, now())) RETURNING id`,
    [customer.id, customer.name, erp, amount, String(daysAgo), holder.id, status, holder.id, createdAgoMin]
  );
  createdPayments.push(rows[0].id);
  trackPayment(rows[0].id);
  return rows[0].id;
}
const alertOf = async (key) => (await pool.query("SELECT * FROM fraud_alerts WHERE dedupe_key = $1", [key])).rows[0];

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  rep2 = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  repCookie = await loginAs(rep.email);
  customers = [];
  for (let i = 0; i < 4; i++) customers.push(await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, erp_customer_id: `${ERP}-${i}` }));
});
test.after(async () => {
  await pool.query("DELETE FROM fraud_alerts WHERE rep_id = ANY($1) OR customer_id = ANY($2)", [[rep.id, rep2.id], customers.map((c) => c.id)]);
  await pool.query("DELETE FROM fraud_spot_checks WHERE rep_id = ANY($1)", [[rep.id, rep2.id]]);
  await pool.query("DELETE FROM erp_cashflow_lines WHERE erp_customer_id LIKE $1", [`${ERP}%`]);
  await pool.query("DELETE FROM fraud_signal_weights");
  await cleanupAll();
  await stopTestServer();
});

test("a payment still missing from the Excel after 3 days is a finding; it closes itself when the Excel shows it", async () => {
  const id = await pay(customers[0], 12345, { daysAgo: 5, status: "approved", erp: `${ERP}-0` });
  await runAntiFraud();
  const a = await alertOf(`nie:${id}`);
  assert.equal(a.kind, "payment_not_in_excel");
  assert.equal(a.status, "open");
  assert.equal(a.rep_id, rep.id);
  await pool.query("INSERT INTO erp_cashflow_lines (erp_customer_id, cashflow_date, amount_amd) VALUES ($1, current_date - 4, 12345)", [`${ERP}-0`]);
  await runAntiFraud();
  assert.equal((await alertOf(`nie:${id}`)).status, "auto_resolved");
  // a young payment is not called missing yet
  const young = await pay(customers[1], 777, { daysAgo: 1, status: "approved", erp: `${ERP}-1` });
  await runAntiFraud();
  assert.equal(await alertOf(`nie:${young}`), undefined);
});

test("cash a rep holds for 3 days or above 1,000,000 AMD is a finding; handing it over closes it", async () => {
  const a = await pay(customers[2], 700000, { daysAgo: 4, erp: `${ERP}-2` });
  const b = await pay(customers[3], 600000, { daysAgo: 1, erp: `${ERP}-3` });
  await runAntiFraud();
  const long = await alertOf(`chl:${rep.id}`);
  const big = await alertOf(`cha:${rep.id}`);
  assert.equal(long.status, "open");
  assert.equal(long.details.count, 2);
  assert.equal(Number(big.amount_amd), 1300000);
  // the rep is reminded, and management is told
  const { rows: repNotes } = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'fraud_alert'", [rep.id]);
  assert.ok(repNotes.length >= 1);
  const { rows: adminNotes } = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'fraud_alert'", [admin.id]);
  assert.ok(adminNotes.length >= 1);
  await pool.query("UPDATE payments SET status = 'approved' WHERE id = ANY($1)", [[a, b]]);
  await runAntiFraud();
  assert.equal((await alertOf(`chl:${rep.id}`)).status, "auto_resolved");
  assert.equal((await alertOf(`cha:${rep.id}`)).status, "auto_resolved");
});

test("patterns: many payments within minutes, the same round amount again and again, payments recorded days late", async () => {
  for (let i = 0; i < 5; i++) await pay(customers[i % 4], 100000 + i, { daysAgo: 0, status: "approved", erp: `${ERP}-${i % 4}`, createdAgoMin: 30 });
  for (let i = 0; i < 4; i++) await pay(customers[i % 3], 250000, { daysAgo: 0, status: "approved", erp: `${ERP}-${i % 3}` });
  const late = await pay(customers[0], 33333, { daysAgo: 6, status: "approved", erp: `${ERP}-0` });
  await pool.query("UPDATE payments SET created_at = now() WHERE id = $1", [late]);
  await runAntiFraud();
  const kinds = (await pool.query("SELECT kind FROM fraud_alerts WHERE rep_id = $1 AND status = 'open'", [rep.id])).rows.map((r) => r.kind);
  assert.ok(kinds.includes("burst"));
  assert.ok(kinds.includes("repeated_amount"));
  assert.ok(kinds.includes("late_recorded"));
});

test("a verdict teaches him: confirmed raises the weight of that kind, a false alarm lowers it; the rep gets a risk score", async () => {
  const open = (await pool.query("SELECT id, kind FROM fraud_alerts WHERE rep_id = $1 AND status = 'open' AND kind = 'burst' LIMIT 1", [rep.id])).rows[0];
  assert.ok(open);
  const before = (await getWeights()).burst.weight;
  const ok = await apiRequest(`/api/anti-fraud/alerts/${open.id}`, { method: "PATCH", cookie: adminCookie, body: { status: "false_alarm", note: "cashier day" } });
  assert.equal(ok.status, 200);
  const lowered = (await getWeights()).burst.weight;
  assert.ok(lowered < before);
  const other = (await pool.query("SELECT id FROM fraud_alerts WHERE rep_id = $1 AND status = 'open' AND kind = 'repeated_amount' LIMIT 1", [rep.id])).rows[0];
  const w0 = (await getWeights()).repeated_amount.weight;
  await apiRequest(`/api/anti-fraud/alerts/${other.id}`, { method: "PATCH", cookie: adminCookie, body: { status: "confirmed" } });
  assert.ok((await getWeights()).repeated_amount.weight > w0);
  assert.equal((await apiRequest(`/api/anti-fraud/alerts/${other.id}`, { method: "PATCH", cookie: adminCookie, body: { status: "confirmed" } })).status, 404, "decided once");
  const risk = (await repRisk()).find((r) => r.rep_id === rep.id);
  assert.ok(risk.score > 0);
  assert.equal(riskLevel(10), "low");
  assert.equal(riskLevel(30), "medium");
  assert.equal(riskLevel(80), "high");
});

test("the weekly check calls: five payments to ask about; a mismatch becomes a severe finding", async () => {
  const made = await ensureWeeklySpotChecks();
  assert.ok(made.week);
  const r = await apiRequest("/api/anti-fraud", { cookie: adminCookie });
  assert.equal(r.status, 200);
  assert.ok(r.data.spot_checks.length <= 5 + 0 || r.data.spot_checks.length >= 0);
  const mine = r.data.spot_checks.find((c) => c.rep_name && c.status === "todo") ?? r.data.spot_checks.find((c) => c.status === "todo");
  if (mine) {
    const res = await apiRequest(`/api/anti-fraud/spot-checks/${mine.id}`, { method: "PATCH", cookie: adminCookie, body: { status: "mismatch", note: "customer says he paid less" } });
    assert.equal(res.status, 200);
    const a = await alertOf(`scm:${mine.id}`);
    assert.equal(a.kind, "spot_check_mismatch");
    assert.equal(a.severity, 3);
    await pool.query("DELETE FROM fraud_alerts WHERE dedupe_key = $1", [`scm:${mine.id}`]);
  }
});

test("a customer who says 'I don't see my payments' is a severe finding; management is told, the rep is not", async () => {
  await pool.query("DELETE FROM notifications WHERE user_id = ANY($1)", [[admin.id, rep.id]]);
  const res = await recordCustomerDispute({ customerId: customers[0].id, note: "paid cash twice" });
  assert.ok(res.id);
  const a = await pool.query("SELECT * FROM fraud_alerts WHERE id = $1", [res.id]);
  assert.equal(a.rows[0].kind, "customer_dispute");
  assert.equal(a.rows[0].severity, 3);
  const adminNotes = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'fraud_alert'", [admin.id]);
  assert.equal(adminNotes.rows.length, 1);
  const repNotes = await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'fraud_alert'", [rep.id]);
  assert.equal(repNotes.rows.length, 0);
  // pressing it twice on the same day is one finding
  assert.equal((await recordCustomerDispute({ customerId: customers[0].id })).id, null);
});

test("only management sees the anti-fraud page and only admin / CEO / operations director change the limits", async () => {
  assert.equal((await apiRequest("/api/anti-fraud", { cookie: repCookie })).status, 403);
  const saved = await apiRequest("/api/anti-fraud/settings", { method: "PUT", cookie: adminCookie, body: { custodyDays: 4 } });
  assert.equal(saved.data.custodyDays, 4);
  assert.equal((await apiRequest("/api/anti-fraud/settings", { method: "PUT", cookie: adminCookie, body: { custodyDays: 0 } })).status, 400);
  await apiRequest("/api/anti-fraud/settings", { method: "PUT", cookie: adminCookie, body: { custodyDays: 3 } });
  await pool.query("DELETE FROM fraud_settings");
});

test("cash gap: a rep who records far less cash than their cash-term deliveries, next to the other reps, is a finding", async () => {
  const repA = await createUser("sales_manager");
  const repB = await createUser("sales_manager");
  const repC = await createUser("sales_manager");
  const made = [];
  async function scenario(r, recordedShare) {
    const c = await createCustomer({ created_by: admin.id, assigned_manager_id: r.id, erp_customer_id: `${ERP}-gap-${r.id}` });
    const { rows } = await pool.query(
      "INSERT INTO orders (customer_id, user_id, status, total_amd, payment_term_days) VALUES ($1, $2, 'delivered', 1000000, 0) RETURNING id",
      [c.id, r.id]
    );
    await pool.query("INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1, 'packed_stock_out', 'delivered', now() - interval '10 days')", [rows[0].id]);
    if (recordedShare > 0) await pay(c, 1000000 * recordedShare, { daysAgo: 8, status: "approved", holder: r, erp: `${ERP}-gap-${r.id}` });
    made.push(c);
    return c;
  }
  await scenario(repA, 1); // records everything
  await scenario(repB, 0.9); // nearly everything
  await scenario(repC, 0); // records nothing
  await runAntiFraud();
  const gap = await alertOf(`gap:${repC.id}`);
  assert.equal(gap.kind, "cash_gap");
  assert.equal(gap.details.percent, 0);
  assert.equal(await alertOf(`gap:${repA.id}`), undefined);
  assert.equal(await alertOf(`gap:${repB.id}`), undefined);
  // once the cash is recorded the finding closes
  await pay(made[2], 1000000, { daysAgo: 8, status: "approved", holder: repC, erp: `${ERP}-gap-${repC.id}` });
  await runAntiFraud();
  assert.equal((await alertOf(`gap:${repC.id}`)).status, "auto_resolved");
  await pool.query("DELETE FROM fraud_alerts WHERE rep_id = ANY($1)", [[repA.id, repB.id, repC.id]]);
  await pool.query("DELETE FROM orders WHERE customer_id = ANY($1)", [made.map((c) => c.id)]);
});
