// Improvement plan, Phase 0 (2026-11-28):
// 0.2  the Map's "every week" tab saves only areas; it must never wipe the customers a weekday got on the Route Plans screen.
// 0.19 closing a month must not drop its plan from the Company Dashboard leaderboard or from "My performance".
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { periodWindow } from "../../src/utils/periodWindows.js";

let admin, adminCookie, rep, repCookie, c1, c2;
let channelId;
const planIds = [];
const CHANNEL = `SM Phase0 ${Date.now()}`;
const lastMonth = `${periodWindow("last_month").from.slice(0, 7)}-01`;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
  rep = await createUser("sales_manager", { name: "Phase0 Rep" });
  repCookie = await loginAs(rep.email);
  c1 = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, sales_channel: "SM Davtashen" });
  c2 = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, sales_channel: "SM Davtashen" });
  const { rows } = await pool.query("INSERT INTO sales_channels (code, name, manager_user_id) VALUES ($1, $1, $2) RETURNING id", [CHANNEL, rep.id]);
  channelId = rows[0].id;
});
test.after(async () => {
  await pool.query("DELETE FROM visit_plan_rules WHERE user_id = $1", [rep.id]);
  if (planIds.length) {
    await pool.query("DELETE FROM perf_plans WHERE id = ANY($1)", [planIds]);
  }
  await pool.query("DELETE FROM sales_performance WHERE rep_name = $1", [CHANNEL]);
  await pool.query("DELETE FROM sales_channels WHERE id = $1", [channelId]);
  await cleanupAll();
  await stopTestServer();
});

const ruleOf = async (day) => (await pool.query("SELECT * FROM visit_plan_rules WHERE user_id = $1 AND day_of_week = $2", [rep.id, day])).rows[0];

test("0.2 a weekday with Route Plans customers survives a Map save that sends areas only", async () => {
  await pool.query(
    "INSERT INTO visit_plan_rules (user_id, day_of_week, areas, customer_ids, created_by, active) VALUES ($1, 2, '[]', $2, $3, true)",
    [rep.id, [c1.id, c2.id], admin.id]
  );
  // the Map tab: areas only, no customer_ids key (old and new clients both send it this way)
  const res = await apiRequest("/api/visit-plans/rules/2", { method: "PUT", cookie: repCookie, body: { areas: [] } });
  assert.equal(res.status, 201);
  const rule = await ruleOf(2);
  assert.deepEqual([...rule.customer_ids].sort((a, b) => a - b), [c1.id, c2.id].sort((a, b) => a - b), "customers kept");
  assert.equal(rule.active, true, "the weekday stays switched on");

  // adding an area on the Map keeps the customers too
  const withArea = await apiRequest("/api/visit-plans/rules/2", { method: "PUT", cookie: repCookie, body: { areas: [{ region: "Yerevan", subregion: null }] } });
  assert.equal(withArea.status, 201);
  const after = await ruleOf(2);
  assert.equal(after.customer_ids.length, 2);
  assert.deepEqual(after.areas, [{ region: "Yerevan", subregion: null }]);
});

test("0.2 an explicit empty list still clears the day; a save without areas keeps the stored areas", async () => {
  const keepAreas = await apiRequest("/api/visit-plans/rules/2", { method: "PUT", cookie: repCookie, body: { customer_ids: [c1.id] } });
  assert.equal(keepAreas.status, 201);
  let rule = await ruleOf(2);
  assert.deepEqual(rule.customer_ids, [c1.id]);
  assert.deepEqual(rule.areas, [{ region: "Yerevan", subregion: null }], "areas not sent = kept");

  const cleared = await apiRequest("/api/visit-plans/rules/2", { method: "PUT", cookie: repCookie, body: { areas: [], customer_ids: [] } });
  assert.equal(cleared.status, 201);
  rule = await ruleOf(2);
  assert.deepEqual(rule.customer_ids, []);
  assert.equal(rule.active, false, "both lists explicitly empty switches the day off, as before");
});

async function insertPlan(month, version, status, target) {
  const { rows } = await pool.query("INSERT INTO perf_plans (month, version, status, created_by) VALUES ($1, $2, $3, $4) RETURNING id", [month, version, status, admin.id]);
  planIds.push(rows[0].id);
  await pool.query("INSERT INTO perf_plan_targets (plan_id, channel_id, sales_target_amd) VALUES ($1, $2, $3)", [rows[0].id, channelId, target]);
  return rows[0].id;
}

test("0.19 a closed month still shows its plan in My performance and on the Company Dashboard leaderboard", async () => {
  const myMonth = "2031-03-01";
  await insertPlan(myMonth, 901, "superseded", 111);
  const closedId = await insertPlan(myMonth, 902, "closed", 5000000);
  await pool.query(
    `INSERT INTO perf_plan_closed_snapshot (plan_id, channel_id, channel_code, channel_name, sales_target_amd, sales_actual_amd, collection_target_amd, collection_actual_amd, new_customers_target, new_customers_actual)
     VALUES ($1, $2, $3, $3, 5000000, 4200000, 0, 3100000, 0, 0)`,
    [closedId, channelId, CHANNEL]
  );
  const mine = await apiRequest(`/api/team-performance/my-performance?month=${myMonth}`, { cookie: repCookie });
  assert.equal(mine.status, 200);
  const row = mine.data.find((r) => r.channel_code === CHANNEL);
  assert.ok(row, "the closed month's channel row is there");
  assert.equal(Number(row.sales.target), 5000000);
  assert.equal(row.closed, true, "a closed month shows the numbers frozen at close");
  assert.equal(Number(row.sales.actual), 4200000);
  assert.equal(Number(row.collections.actual), 3100000);

  await insertPlan(lastMonth, 903, "closed", 7000000);
  await pool.query("INSERT INTO sales_performance (rep_name, month, sales_amd, collected_amd) VALUES ($1, $2, 1000, 500)", [CHANNEL, lastMonth]);
  const board = await apiRequest("/api/sales-performance/?period=last_month", { cookie: adminCookie });
  assert.equal(board.status, 200);
  const line = board.data.find((r) => r.rep_name === CHANNEL);
  assert.ok(line);
  assert.equal(Number(line.plan_amd), 7000000, "closed plan counted once");
});
