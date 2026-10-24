// "SM B2B Artak as a separate plan": one person owns SM Davtashen AND SM B2B customers. The recurring plan stays one rule
// per person and weekday (so today's visits / Vaghinak / the map keep reading one list), but the planners see and edit
// two PLANS: the main one and the SM B2B one. B2B customers are not part of the main (Davtashen) plan any more.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { mergeScopeIds, parseScope, scopesFor } from "../../src/planScopes.js";
import { planRepByScope } from "../../src/routePlanSets.js";

let admin, adminCookie, repCookie, rep;
let m1, m2, b1, b2;
let setId;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
  rep = await createUser("sales_manager", { name: "Artak Scopes" });
  repCookie = await loginAs(rep.email);
  const mk = (channel, extra = {}) => createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, sales_channel: channel, ...extra });
  m1 = await mk("SM Davtashen", { lat: 40.2, lng: 44.5 });
  m2 = await mk("SM Davtashen", { lat: 40.21, lng: 44.5 });
  b1 = await mk("SM B2B", { lat: 40.3, lng: 44.6 });
  b2 = await mk("SM B2B", { lat: 40.31, lng: 44.6 });
  // today's setup: one Monday rule that lists a Davtashen AND a B2B customer
  await pool.query("INSERT INTO visit_plan_rules (user_id, day_of_week, areas, customer_ids, created_by, active) VALUES ($1, 1, '[]', $2, $3, true)", [rep.id, [m1.id, b1.id], admin.id]);
});
test.after(async () => {
  if (setId) await pool.query("DELETE FROM route_plan_sets WHERE id = $1", [setId]);
  await pool.query("DELETE FROM visit_plan_rules WHERE user_id = $1", [rep.id]);
  await cleanupAll();
  await stopTestServer();
});

const planOf = (overview, scope) => overview.find((r) => r.user_id === rep.id).plans.find((p) => p.scope === scope);
const mondayOf = (plan) => plan.days.find((d) => d.day_of_week === 1);

test("pure helpers: scope parsing, merging keeps the other plan, scopes appear only with customers", () => {
  assert.equal(parseScope(""), "");
  assert.equal(parseScope(undefined), "");
  assert.equal(parseScope("SM B2B"), "SM B2B");
  assert.equal(parseScope("KF"), null);
  const channelOf = new Map([[1, "SM Davtashen"], [2, "SM B2B"], [3, "SM B2B"], [4, "retail"]]);
  assert.deepEqual(mergeScopeIds({ existing: [1, 2], submitted: [3, 1], scope: "SM B2B", channelOf }).sort(), [1, 3]);
  assert.deepEqual(mergeScopeIds({ existing: [1, 2, 99], submitted: [4], scope: "", channelOf }).sort(), [2, 4], "unknown ids dropped, main plan replaced");
  assert.deepEqual(scopesFor([1, 4], channelOf), [""]);
  assert.deepEqual(scopesFor([1, 2], channelOf), ["", "SM B2B"]);
});

test("overview: the person has a main plan and a separate SM B2B plan; each counts only its own customers", async () => {
  const res = await apiRequest("/api/visit-plans/rules/overview", { cookie: adminCookie });
  assert.equal(res.status, 200);
  const main = planOf(res.data, "");
  const b2b = planOf(res.data, "SM B2B");
  assert.ok(main && b2b);
  assert.equal(mondayOf(main).customer_count, 1);
  assert.equal(mondayOf(b2b).customer_count, 1);
  assert.deepEqual(mondayOf(main).customer_ids, [m1.id]);
  assert.deepEqual(mondayOf(b2b).customer_ids, [b1.id]);
  assert.deepEqual(res.data.find((r) => r.user_id === rep.id).days, res.data.find((r) => r.user_id === rep.id).plans[0].days, "top-level days = main plan");
  // the red badge: customers of the plan that are on no weekday (m2 and b2 have no day)
  assert.equal(main.unplanned_count, 1);
  assert.equal(b2b.unplanned_count, 1);
  // a never-visited channel or a competitor needs no place in the plan
  const extra = await createCustomer({ created_by: admin.id, assigned_manager_id: rep.id, sales_channel: "SM Davtashen", lat: 40.22, lng: 44.5 });
  await pool.query("UPDATE customers SET customer_tier = 'competitor' WHERE id = $1", [extra.id]);
  assert.equal(planOf((await apiRequest("/api/visit-plans/rules/overview", { cookie: adminCookie })).data, "").unplanned_count, 1, "competitors are not counted");
  await pool.query("DELETE FROM customers WHERE id = $1", [extra.id]);
});

test("customers list per plan: ?scope= limits it, bad scope is refused", async () => {
  const get = (q) => apiRequest(`/api/visit-plans/rules/customers?user_id=${rep.id}${q}`, { cookie: adminCookie });
  const ids = (res) => res.data.customers.map((c) => c.id).sort((a, b) => a - b);
  assert.deepEqual(ids(await get("&scope=")), [m1.id, m2.id]);
  assert.deepEqual(ids(await get("&scope=SM%20B2B")), [b1.id, b2.id]);
  assert.deepEqual(ids(await get("")), [m1.id, m2.id, b1.id, b2.id], "no scope = everything (older clients)");
  assert.equal((await get("&scope=KF")).status, 400);
});

test("saving one plan's day never touches the other plan's customers", async () => {
  const put = (body) => apiRequest("/api/visit-plans/rules/1", { method: "PUT", cookie: adminCookie, body: { user_id: rep.id, areas: [], ...body } });
  const rule = async () => (await pool.query("SELECT customer_ids, active FROM visit_plan_rules WHERE user_id = $1 AND day_of_week = 1", [rep.id])).rows[0];

  // B2B plan: both B2B customers on Monday (and an attempted Davtashen id is ignored)
  assert.equal((await put({ plan_channel: "SM B2B", customer_ids: [b1.id, b2.id, m2.id] })).status, 201);
  assert.deepEqual((await rule()).customer_ids.sort((a, b) => a - b), [m1.id, b1.id, b2.id]);

  // main plan: only m2 -> m1 leaves, B2B stays
  assert.equal((await put({ plan_channel: "", customer_ids: [m2.id] })).status, 201);
  assert.deepEqual((await rule()).customer_ids.sort((a, b) => a - b), [m2.id, b1.id, b2.id]);

  // clearing the B2B plan keeps the main one
  assert.equal((await put({ plan_channel: "SM B2B", customer_ids: [] })).status, 201);
  const after = await rule();
  assert.deepEqual(after.customer_ids, [m2.id]);
  assert.equal(after.active, true);

  assert.equal((await put({ plan_channel: "KF", customer_ids: [] })).status, 400);
  // without plan_channel the whole rule is replaced (Map quick planner behaviour is unchanged)
  assert.equal((await put({ customer_ids: [m1.id] })).status, 201);
  assert.deepEqual((await rule()).customer_ids, [m1.id]);
});

test("a rep sees their own plans (main + B2B) without the all-plans permission", async () => {
  await apiRequest("/api/visit-plans/rules/2", { method: "PUT", cookie: adminCookie, body: { user_id: rep.id, areas: [], plan_channel: "SM B2B", customer_ids: [b2.id] } });
  const res = await apiRequest("/api/visit-plans/rules/plans", { cookie: repCookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.plans.map((p) => p.scope), ["", "SM B2B"]);
  assert.equal(res.data.plans[1].days.find((d) => d.day_of_week === 2).customer_count, 1);
  assert.equal(res.data.plans[0].days.find((d) => d.day_of_week === 2).customer_count, 0);
});

test("auto planner: each plan spreads over the working days on its own, then the day lists are joined", () => {
  const days = [1, 2, 3].map((dow) => ({ dow, weight: 1 }));
  const cs = [];
  for (let i = 0; i < 6; i++) cs.push({ id: 100 + i, lat: 40.2 + i * 0.001, lng: 44.5, sales_channel: "SM Davtashen" });
  for (let i = 0; i < 3; i++) cs.push({ id: 200 + i, lat: 40.3 + i * 0.001, lng: 44.6, sales_channel: "SM B2B" });
  const plan = planRepByScope(cs, days);
  assert.equal([...plan.values()].flat().length, 9);
  for (const ids of plan.values()) {
    assert.equal(ids.filter((id) => id >= 200).length, 1, "the 3 B2B customers are spread one per day");
    assert.equal(ids.filter((id) => id < 200).length, 2, "the 6 main customers are spread two per day");
  }
});

test("route plan set editor: two plans for one person, saving the B2B plan keeps the main plan", async () => {
  const { rows } = await pool.query("INSERT INTO route_plan_sets (name, kind, created_by) VALUES ('scopes', 'manual', $1) RETURNING id", [admin.id]);
  setId = rows[0].id;
  await pool.query("INSERT INTO route_plan_set_rules (set_id, user_id, day_of_week, customer_ids) VALUES ($1, $2, 1, $3), ($1, $2, 2, $4)", [setId, rep.id, [m1.id, b1.id], [m2.id]]);
  const get = async () => (await apiRequest(`/api/route-plan-sets/${setId}`, { cookie: adminCookie })).data.reps.filter((r) => r.user_id === rep.id);
  const idsOf = (e) => e.days.flatMap((d) => d.customers.map((c) => c.id)).sort((a, b) => a - b);

  const entries = await get();
  assert.deepEqual(entries.map((r) => r.scope), ["", "SM B2B"]);
  assert.deepEqual(idsOf(entries[0]), [m1.id, m2.id].sort((a, b) => a - b), "Davtashen plan has no B2B customer");
  assert.deepEqual(idsOf(entries[1]), [b1.id]);
  assert.deepEqual(entries[1].unplanned.map((c) => c.id), [b2.id]);
  assert.equal(entries[1].customer_total, 2);

  // move B2B onto Friday (both customers); the main plan must not change
  const res = await apiRequest(`/api/route-plan-sets/${setId}/reps/${rep.id}`, { method: "PUT", cookie: adminCookie, body: { scope: "SM B2B", days: { 5: [b1.id, b2.id] } } });
  assert.equal(res.status, 200);
  const after = await get();
  assert.deepEqual(idsOf(after[0]), [m1.id, m2.id].sort((a, b) => a - b));
  assert.deepEqual(after[1].days.find((d) => d.day_of_week === 5).customers.map((c) => c.id), [b1.id, b2.id]);
  assert.equal(after[1].unplanned.length, 0);

  // and the main plan can be saved without touching B2B
  await apiRequest(`/api/route-plan-sets/${setId}/reps/${rep.id}`, { method: "PUT", cookie: adminCookie, body: { scope: "", days: { 3: [m1.id, m2.id] } } });
  const last = await get();
  assert.deepEqual(last[0].days.find((d) => d.day_of_week === 3).customers.map((c) => c.id), [m1.id, m2.id]);
  assert.deepEqual(last[1].days.find((d) => d.day_of_week === 5).customers.map((c) => c.id), [b1.id, b2.id]);
  assert.equal((await apiRequest(`/api/route-plan-sets/${setId}/reps/${rep.id}`, { method: "PUT", cookie: adminCookie, body: { scope: "KF", days: {} } })).status, 400);
});
