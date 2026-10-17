// Owner, 2026-10-18: a customer a rep visited yesterday is not on the next recurring route day.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";

let mgr, adminU, mgrCookie, adminCookie, cust;
const DATE = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 3);
  return d.toISOString().slice(0, 10);
})();
const dayBefore = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) - n * 86400000).toISOString();

test.before(async () => {
  await startTestServer();
  adminU = await createUser("admin");
  mgr = await createUser("sales_manager");
  adminCookie = await loginAs(adminU.email);
  mgrCookie = await loginAs(mgr.email);
  cust = await createCustomer({ created_by: mgr.id });
  await pool.query("UPDATE customers SET visit_frequency_days = 7 WHERE id = $1", [cust.id]);
  const dow = new Date(`${DATE}T00:00:00Z`).getUTCDay();
  const put = await apiRequest(`/api/visit-plans/rules/${dow}`, { method: "PUT", cookie: mgrCookie, body: { customer_ids: [cust.id] } });
  assert.equal(put.status, 201);
  const { rows } = await pool.query(
    `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, outcomes, "timestamp")
     VALUES ($1, $2, 40.18, 44.51, 10, true, ARRAY['no_order'], $3) RETURNING id`,
    [cust.id, mgr.id, dayBefore(DATE, 1)]
  );
  trackCheckin(rows[0].id);
});
test.after(async () => {
  await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { plan_skip_recent_visit_days: 4 } });
  await pool.query("DELETE FROM visit_plan_rules WHERE user_id = $1", [mgr.id]);
  await cleanupAll();
  await stopTestServer();
});

test("the rule day right after a visit leaves the customer out; turning the setting off brings it back", async () => {
  const on = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { plan_skip_recent_visit_days: 4 } });
  assert.equal(on.status, 200);
  const skipped = await apiRequest(`/api/visit-plans/mine?date=${DATE}`, { cookie: mgrCookie });
  assert.equal(skipped.status, 200);
  assert.ok(!skipped.data || !(skipped.data.customer_ids ?? []).includes(cust.id));
  await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { plan_skip_recent_visit_days: 0 } });
  const back = await apiRequest(`/api/visit-plans/mine?date=${DATE}`, { cookie: mgrCookie });
  assert.ok(back.data.customer_ids.includes(cust.id));
});

test("a one-day plan written by hand is never filtered", async () => {
  await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { plan_skip_recent_visit_days: 4 } });
  const post = await apiRequest("/api/visit-plans", { method: "POST", cookie: adminCookie, body: { user_id: mgr.id, date: DATE, customer_ids: [cust.id] } });
  assert.equal(post.status, 201);
  const res = await apiRequest(`/api/visit-plans/mine?date=${DATE}`, { cookie: mgrCookie });
  assert.ok(res.data.customer_ids.includes(cust.id));
  await pool.query("DELETE FROM visit_plans WHERE user_id = $1", [mgr.id]);
});

test("the schedule shows the next route day after the window, not the skipped one", async () => {
  await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { plan_skip_recent_visit_days: 4 } });
  const res = await apiRequest(`/api/customers/${cust.id}/visit-schedule`, { cookie: mgrCookie });
  const rule = res.data.planned.filter((p) => p.source === "rule").map((p) => p.date);
  assert.ok(!rule.includes(DATE));
});
