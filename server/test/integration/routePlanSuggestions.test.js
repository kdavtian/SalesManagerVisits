// Owner, 2026-11-03: Vaghinak analyses the route plans and SUGGESTS; nothing changes until the CEO accepts (one by one or all); every decision is logged.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { analyzePlan } from "../../src/field/routePlanAnalysis.js";

let admin, ceo, rep, adminCookie, ceoCookie, repCookie, outlier, newOne, mon, wed;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  ceo = await createUser("ceo");
  rep = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  ceoCookie = await loginAs(ceo.email);
  repCookie = await loginAs(rep.email);
  const around = async (lat, lng, n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(await createCustomer({ created_by: rep.id, lat: lat + i * 0.0006, lng: lng + i * 0.0006 }));
    return out;
  };
  mon = await around(40.18, 44.51, 6);
  wed = await around(40.26, 44.62, 6); // ~12 km from Monday's group
  outlier = await createCustomer({ created_by: rep.id, lat: 40.2605, lng: 44.6205 }); // next to Wednesday's group but listed on Monday
  newOne = await createCustomer({ created_by: rep.id, lat: 40.1815, lng: 44.5115 }); // on no weekday, next to Monday's group
  await pool.query("INSERT INTO visit_plan_rules (user_id, day_of_week, customer_ids, created_by) VALUES ($1, 1, $2, $3), ($1, 3, $4, $3)", [rep.id, [...mon.map((c) => c.id), outlier.id], admin.id, wed.map((c) => c.id)]);
});
test.after(async () => {
  await pool.query("DELETE FROM route_plan_suggestions WHERE rep_id = $1", [rep.id]);
  await pool.query("DELETE FROM visit_plan_rules WHERE user_id = $1", [rep.id]);
  await cleanupAll();
  await stopTestServer();
});

test("analyzePlan: a far customer moves to the day it is next to; an unplanned one joins the nearest day", () => {
  const pts = (arr) => new Map(arr.map((c) => [c.id, { lat: c.lat, lng: c.lng }]));
  const all = [...mon, ...wed, outlier, newOne].map((c) => ({ id: c.id, lat: Number(c.lat), lng: Number(c.lng) }));
  const out = analyzePlan({
    days: [
      { day_of_week: 1, ids: [...mon.map((c) => c.id), outlier.id], movable: [...mon.map((c) => c.id), outlier.id] },
      { day_of_week: 3, ids: wed.map((c) => c.id), movable: wed.map((c) => c.id) },
    ],
    byId: pts(all),
    unplanned: [all.find((c) => c.id === newOne.id)],
  });
  const move = out.find((s) => s.kind === "move");
  assert.equal(move.customer_id, outlier.id);
  assert.equal(move.from_dow, 1);
  assert.equal(move.to_dow, 3);
  const add = out.find((s) => s.kind === "add");
  assert.equal(add.customer_id, newOne.id);
  assert.equal(add.to_dow, 1);
});

test("only the CEO / admin see and decide; nothing changes in the plan before an accept", async () => {
  assert.equal((await apiRequest("/api/route-plan-suggestions", { cookie: repCookie })).status, 403);
  const run = await apiRequest("/api/route-plan-suggestions/analyze", { method: "POST", cookie: ceoCookie });
  assert.equal(run.status, 200);
  const list = await apiRequest("/api/route-plan-suggestions", { cookie: ceoCookie });
  const mine = list.data.pending.filter((s) => s.rep_id === rep.id);
  assert.ok(mine.some((s) => s.kind === "move" && s.customer_id === outlier.id));
  assert.ok(mine.some((s) => s.kind === "add" && s.customer_id === newOne.id));
  const { rows: [mondayRule] } = await pool.query("SELECT customer_ids FROM visit_plan_rules WHERE user_id = $1 AND day_of_week = 1", [rep.id]);
  assert.ok(mondayRule.customer_ids.includes(outlier.id), "plan untouched before accept");
});

test("accept one: the plan changes and the decision is logged; dismiss keeps the plan; accept all applies the rest", async () => {
  const list = await apiRequest("/api/route-plan-suggestions", { cookie: ceoCookie });
  const move = list.data.pending.find((s) => s.rep_id === rep.id && s.kind === "move");
  const add = list.data.pending.find((s) => s.rep_id === rep.id && s.kind === "add");
  const ok = await apiRequest(`/api/route-plan-suggestions/${move.id}/accept`, { method: "POST", cookie: ceoCookie });
  assert.equal(ok.status, 200);
  const rules = (await pool.query("SELECT day_of_week, customer_ids FROM visit_plan_rules WHERE user_id = $1", [rep.id])).rows;
  assert.ok(!rules.find((r) => r.day_of_week === 1).customer_ids.includes(outlier.id));
  assert.ok(rules.find((r) => r.day_of_week === 3).customer_ids.includes(outlier.id));
  const { rows: [logged] } = await pool.query("SELECT status, decided_by FROM route_plan_suggestions WHERE id = $1", [move.id]);
  assert.equal(logged.status, "accepted");
  assert.equal(logged.decided_by, ceo.id);
  const again = await apiRequest(`/api/route-plan-suggestions/${move.id}/accept`, { method: "POST", cookie: ceoCookie });
  assert.equal(again.status, 409);
  const dismiss = await apiRequest(`/api/route-plan-suggestions/${add.id}/dismiss`, { method: "POST", cookie: adminCookie });
  assert.equal(dismiss.status, 200);
  const rulesAfter = (await pool.query("SELECT customer_ids FROM visit_plan_rules WHERE user_id = $1 AND day_of_week = 1", [rep.id])).rows[0];
  assert.ok(!rulesAfter.customer_ids.includes(newOne.id), "dismissed: not added");
  // a dismissed suggestion is not suggested again by the next analysis
  await apiRequest("/api/route-plan-suggestions/analyze", { method: "POST", cookie: ceoCookie });
  const next = await apiRequest("/api/route-plan-suggestions", { cookie: ceoCookie });
  assert.ok(!next.data.pending.some((s) => s.rep_id === rep.id && s.customer_id === newOne.id));
});

test("a plan that changed meanwhile makes the suggestion stale instead of applying it", async () => {
  await pool.query("UPDATE visit_plan_rules SET customer_ids = array_append(customer_ids, $2) WHERE user_id = $1 AND day_of_week = 3 AND NOT ($2 = ANY(customer_ids))", [rep.id, newOne.id]);
  const { rows: [s] } = await pool.query("INSERT INTO route_plan_suggestions (rep_id, customer_id, kind, to_dow, reason) VALUES ($1, $2, 'add', 1, '{}') RETURNING id", [rep.id, newOne.id]);
  const r = await apiRequest(`/api/route-plan-suggestions/${s.id}/accept`, { method: "POST", cookie: ceoCookie });
  assert.equal(r.status, 409);
  assert.equal((await pool.query("SELECT status FROM route_plan_suggestions WHERE id = $1", [s.id])).rows[0].status, "stale");
});
