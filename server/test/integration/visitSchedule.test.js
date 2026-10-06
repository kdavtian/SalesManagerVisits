// GET /api/customers/:id/visit-schedule joins what used to live apart:
// one-off day plans, recurring weekday rules (Route Plans) and the
// customer's own visit cadence -- the Map pin used to read only the first.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let mgr, other, adminU, mgrCookie, adminCookie, otherCookie, cust;
const ids = { rules: [], plans: [] };

function weekdayOfOffset(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCDay();
}

test.before(async () => {
  await startTestServer();
  adminU = await createUser("admin");
  mgr = await createUser("sales_manager");
  other = await createUser("sales_manager");
  adminCookie = await loginAs(adminU.email);
  mgrCookie = await loginAs(mgr.email);
  otherCookie = await loginAs(other.email);
  cust = await createCustomer({ created_by: mgr.id });
  await pool.query("UPDATE customers SET visit_frequency_days = 7 WHERE id = $1", [cust.id]);
});
test.after(async () => {
  await pool.query("DELETE FROM visit_plan_rules WHERE user_id = ANY($1)", [[mgr.id, other.id]]);
  await pool.query("DELETE FROM visit_plans WHERE user_id = ANY($1)", [[mgr.id, other.id]]);
  await cleanupAll();
  await stopTestServer();
});

test("never visited and nothing planned: empty plan list, cadence flags never_visited", async () => {
  const res = await apiRequest(`/api/customers/${cust.id}/visit-schedule`, { cookie: mgrCookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.planned, []);
  assert.equal(res.data.cadence.frequency_days, 7);
  assert.equal(res.data.cadence.never_visited, true);
  assert.equal(res.data.cadence.due_by, null);
});

test("a recurring weekday rule shows its upcoming dates (a week apart), tagged source=rule", async () => {
  const dow = weekdayOfOffset(2);
  const put = await apiRequest(`/api/visit-plans/rules/${dow}`, { method: "PUT", cookie: mgrCookie, body: { customer_ids: [cust.id] } });
  assert.equal(put.status, 201);
  const res = await apiRequest(`/api/customers/${cust.id}/visit-schedule`, { cookie: mgrCookie });
  const rules = res.data.planned.filter((p) => p.source === "rule");
  assert.ok(rules.length >= 3 && rules.length <= 6);
  assert.equal(new Date(`${rules[1].date}T00:00:00Z`) - new Date(`${rules[0].date}T00:00:00Z`), 7 * 24 * 3600 * 1000);
  assert.ok(rules.every((r) => r.user_id === mgr.id));
});

test("an explicit plan row for that day overrides the rule (here: plan without the customer -> date disappears)", async () => {
  const first = (await apiRequest(`/api/customers/${cust.id}/visit-schedule`, { cookie: mgrCookie })).data.planned[0].date;
  const post = await apiRequest("/api/visit-plans", { method: "POST", cookie: adminCookie, body: { user_id: mgr.id, date: first, customer_ids: [] } });
  assert.equal(post.status, 201);
  const res = await apiRequest(`/api/customers/${cust.id}/visit-schedule`, { cookie: mgrCookie });
  assert.ok(!res.data.planned.some((p) => p.date === first));
});

test("cadence: planned date = last visit + frequency (or next route day); overdue when past", async () => {
  const { rows } = await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, timestamp)
     VALUES ($1, $2, 40.18, 44.51, 5, true, ARRAY['no_order'], now() - interval '40 days') RETURNING id`,
    [cust.id, mgr.id]
  );
  trackCheckin(rows[0].id);
  const res = await apiRequest(`/api/customers/${cust.id}/visit-schedule`, { cookie: mgrCookie });
  assert.equal(res.data.cadence.never_visited, false);
  assert.equal(res.data.cadence.overdue, true);
  assert.ok(res.data.cadence.due_by < res.data.today);
  assert.ok(res.data.cadence.overdue_days > 0);
});

test("a sales manager never sees another manager's plans; admin sees everyone's", async () => {
  const dow = weekdayOfOffset(3);
  await apiRequest(`/api/visit-plans/rules/${dow}`, { method: "PUT", cookie: adminCookie, body: { user_id: other.id, customer_ids: [cust.id] } });
  const asMgr = await apiRequest(`/api/customers/${cust.id}/visit-schedule`, { cookie: mgrCookie });
  assert.ok(asMgr.data.planned.every((p) => p.user_id === mgr.id));
  const asAdmin = await apiRequest(`/api/customers/${cust.id}/visit-schedule`, { cookie: adminCookie });
  assert.ok(asAdmin.data.planned.some((p) => p.user_id === other.id));
  const asOther = await apiRequest(`/api/customers/${cust.id}/visit-schedule`, { cookie: otherCookie });
  assert.ok(asOther.data.planned.every((p) => p.user_id === other.id));
});
