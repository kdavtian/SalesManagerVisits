// Owner, 2026-11-03: the rep's day against the mandatory share ("today X of Y needed" + the month), and competitors never land in a rule day.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { yerevanToday } from "../../src/utils/yerevanDate.js";

let mgr, mgrCookie, customers, competitor;
const today = yerevanToday();

test.before(async () => {
  await startTestServer();
  mgr = await createUser("sales_manager");
  mgrCookie = await loginAs(mgr.email);
  customers = [];
  for (let i = 0; i < 4; i++) customers.push(await createCustomer({ created_by: mgr.id }));
  competitor = await createCustomer({ created_by: mgr.id });
  await pool.query("UPDATE customers SET customer_tier = 'competitor', region = 'ZZ Test Region' WHERE id = $1", [competitor.id]);
  await pool.query("UPDATE customers SET region = 'ZZ Test Region' WHERE id = $1", [customers[0].id]);
  await pool.query("INSERT INTO visit_plans (user_id, plan_date, customer_ids, status, created_by) VALUES ($1, $2, $3, 'approved', $1)", [mgr.id, today, customers.map((c) => c.id)]);
  const { rows } = await pool.query("INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range) VALUES ($1, $2, 40.18, 44.51, 5, true) RETURNING id", [customers[0].id, mgr.id]);
  trackCheckin(rows[0].id);
});
test.after(async () => {
  await pool.query("DELETE FROM visit_plans WHERE user_id = $1", [mgr.id]);
  await pool.query("DELETE FROM visit_plan_rules WHERE user_id = $1", [mgr.id]);
  await cleanupAll();
  await stopTestServer();
});

test("my-day: 75 % of 4 planned = 3 needed, 1 done; the month counts the check-in", async () => {
  const r = await apiRequest("/api/visit-plans/my-day", { cookie: mgrCookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.planned, 4);
  assert.equal(r.data.done, 1);
  assert.equal(r.data.pct, 75);
  assert.equal(r.data.required, 3);
  assert.deepEqual(r.data.done_ids, [customers[0].id]);
  assert.ok(r.data.month.visits >= 1);
});

test("my-day: no plan today means zero planned", async () => {
  await pool.query("DELETE FROM visit_plans WHERE user_id = $1", [mgr.id]);
  const r = await apiRequest("/api/visit-plans/my-day", { cookie: mgrCookie });
  assert.equal(r.data.planned, 0);
  assert.equal(r.data.required, 0);
});

test("a rule day built from an area leaves competitors out", async () => {
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const put = await apiRequest(`/api/visit-plans/rules/${dow}`, { method: "PUT", cookie: mgrCookie, body: { areas: [{ region: "ZZ Test Region" }] } });
  assert.equal(put.status, 201);
  const plan = await apiRequest("/api/visit-plans/mine", { cookie: mgrCookie });
  assert.ok(plan.data.customer_ids.includes(customers[0].id));
  assert.ok(!plan.data.customer_ids.includes(competitor.id));
});
