// Route plan sets: the automatic planner (pure) and the sets API (create auto plan, edit, duplicate, activate, switch).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { planRep, splitCapacities, pathKm, orderStops } from "../../src/routePlanner.js";

const WEEK = [{ dow: 1, weight: 1 }, { dow: 2, weight: 1 }, { dow: 3, weight: 1 }, { dow: 4, weight: 1 }, { dow: 5, weight: 1 }, { dow: 6, weight: 0.5 }];

test("splitCapacities: whole numbers summing to n, half day gets about half", () => {
  assert.deepEqual(splitCapacities(61, [1, 1, 1, 1, 1, 0.5]), [11, 11, 11, 11, 11, 6]);
  assert.deepEqual(splitCapacities(0, [1, 1]), [0, 0]);
  assert.equal(splitCapacities(7, [1, 1, 1, 0.5]).reduce((s, c) => s + c, 0), 7);
});

test("planRep: every customer on exactly one day, loads follow the day weights, days are compact", () => {
  // two far-apart clusters of 30 customers each
  const cs = [];
  for (let i = 0; i < 30; i++) cs.push({ id: i + 1, lat: 40.1 + (i % 6) * 0.002, lng: 44.4 + Math.floor(i / 6) * 0.002 });
  for (let i = 0; i < 30; i++) cs.push({ id: i + 101, lat: 40.3 + (i % 6) * 0.002, lng: 44.7 + Math.floor(i / 6) * 0.002 });
  const plan = planRep(cs, WEEK);
  const all = [...plan.values()].flat();
  assert.equal(all.length, 60);
  assert.equal(new Set(all).size, 60);
  assert.deepEqual([...plan.values()].map((ids) => ids.length), [11, 11, 11, 11, 10, 6].map((n, i) => splitCapacities(60, [1, 1, 1, 1, 1, 0.5])[i]));
  const byId = new Map(cs.map((c) => [c.id, c]));
  // no day mixes the two clusters except at most the one day that straddles the split
  const mixed = [...plan.values()].filter((ids) => ids.some((i) => i < 100) && ids.some((i) => i > 100));
  assert.ok(mixed.length <= 1, "clusters stay together");
  const km = [...plan.values()].reduce((s, ids) => s + pathKm(ids.map((i) => byId.get(i))), 0);
  const shuffled = cs.slice().sort((a, b) => ((a.id * 7919) % 13) - ((b.id * 7919) % 13));
  const randomKm = [0, 10, 20, 30, 40, 50].reduce((s, from) => s + pathKm(shuffled.slice(from, from + 10)), 0);
  assert.ok(km < randomKm / 3, `planned ${km.toFixed(1)} km vs arbitrary ${randomKm.toFixed(1)} km`);
});

test("planRep: customers without a pin are still planned; fewer customers than days is fine", () => {
  const plan = planRep([{ id: 1, lat: 0, lng: 0 }, { id: 2, lat: 40.1, lng: 44.5 }], WEEK);
  assert.deepEqual([...plan.values()].flat().sort(), [1, 2]);
  assert.equal(planRep([], WEEK).size, 6);
  assert.equal(orderStops([{ id: 1, lat: 40, lng: 44 }]).length, 1);
});

let admin, adminCookie, repA, repB, accountant, setIds = [];
const custA = [];
const custB = [];

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  adminCookie = await loginAs(admin.email);
  repA = await createUser("sales_manager");
  repB = await createUser("sales_manager");
  accountant = await createUser("accountant");
  for (let i = 0; i < 13; i++) custA.push(await createCustomer({ created_by: repA.id, lat: 40.1 + (i % 4) * 0.003, lng: 44.4 + Math.floor(i / 4) * 0.003 }));
  for (let i = 0; i < 4; i++) custB.push(await createCustomer({ created_by: repB.id, lat: 40.2 + i * 0.002, lng: 44.6 }));
  // a customer on a never-visited channel is not planned
  custB.push(await createCustomer({ created_by: repB.id, sales_channel: "KF" }));
});
test.after(async () => {
  await pool.query("DELETE FROM route_plan_sets WHERE created_by = $1", [admin.id]);
  await pool.query("DELETE FROM visit_plan_rules WHERE created_by = $1 OR user_id = ANY($2)", [admin.id, [repA.id, repB.id]]);
  await cleanupAll();
  await stopTestServer();
});

const days = { 1: "full", 2: "full", 3: "full", 4: "full", 5: "full", 6: "half" };
const repOf = (set, user) => set.reps.find((r) => r.user_id === user.id);

test("POST /route-plan-sets/auto: each rep's own customers once on the working days, half day lighter, frequency stored", async () => {
  const res = await apiRequest("/api/route-plan-sets/auto", { method: "POST", cookie: adminCookie, body: { name: "T14", frequency_days: 14, days } });
  assert.equal(res.status, 201, JSON.stringify(res.data).slice(0, 300));
  setIds.push(res.data.id);
  const a = repOf(res.data, repA);
  const ids = a.days.flatMap((d) => d.customers.map((c) => c.id));
  assert.equal(ids.length, 13);
  assert.deepEqual([...ids].sort((x, y) => x - y), custA.map((c) => c.id).sort((x, y) => x - y));
  assert.equal(a.unplanned.length, 0);
  assert.deepEqual(a.days.map((d) => d.day_of_week), [1, 2, 3, 4, 5, 6, 0]);
  assert.equal(a.days.find((d) => d.day_of_week === 0).customers.length, 0, "Sunday is off");
  const sat = a.days.find((d) => d.day_of_week === 6).customers.length;
  const mon = a.days.find((d) => d.day_of_week === 1).customers.length;
  assert.ok(sat < mon, "Saturday (half day) is lighter than Monday");
  const b = repOf(res.data, repB);
  assert.equal(b.days.flatMap((d) => d.customers).length, 4, "the KF customer is never planned");
  assert.ok(a.days.flatMap((d) => d.customers).every((c) => c.frequency_days === 14));
  assert.equal(res.data.params.frequency_days, 14);
});

test("permissions: sales manager cannot create/read sets, accountant can only read", async () => {
  const rep = await loginAs(repA.email);
  assert.equal((await apiRequest("/api/route-plan-sets", { cookie: rep })).status, 403);
  assert.equal((await apiRequest("/api/route-plan-sets/auto", { method: "POST", cookie: rep, body: { frequency_days: 7, days } })).status, 403);
  const acc = await loginAs(accountant.email);
  assert.equal((await apiRequest("/api/route-plan-sets", { cookie: acc })).status, 200);
  assert.equal((await apiRequest(`/api/route-plan-sets/${setIds[0]}/activate`, { method: "POST", cookie: acc, body: {} })).status, 403);
  assert.equal((await apiRequest("/api/route-plan-sets/auto", { method: "POST", cookie: adminCookie, body: { frequency_days: 0, days } })).status, 400);
  assert.equal((await apiRequest("/api/route-plan-sets/auto", { method: "POST", cookie: adminCookie, body: { frequency_days: 7, days: {} } })).status, 400);
});

test("rearrange: PUT a rep's days moves customers between weekdays; unplanned customers show up", async () => {
  const set = (await apiRequest(`/api/route-plan-sets/${setIds[0]}`, { cookie: adminCookie })).data;
  const a = repOf(set, repA);
  const mon = a.days.find((d) => d.day_of_week === 1).customers.map((c) => c.id);
  const tue = a.days.find((d) => d.day_of_week === 2).customers.map((c) => c.id);
  // swap Monday and Tuesday, and drop the first Wednesday customer (becomes unplanned)
  const wed = a.days.find((d) => d.day_of_week === 3).customers.map((c) => c.id);
  const dropped = wed.shift();
  const body = { days: { 1: tue, 2: mon, 3: wed, 4: a.days.find((d) => d.day_of_week === 4).customers.map((c) => c.id), 5: a.days.find((d) => d.day_of_week === 5).customers.map((c) => c.id), 6: a.days.find((d) => d.day_of_week === 6).customers.map((c) => c.id) } };
  const res = await apiRequest(`/api/route-plan-sets/${setIds[0]}/reps/${repA.id}`, { method: "PUT", cookie: adminCookie, body });
  assert.equal(res.status, 200);
  const after = repOf(res.data, repA);
  assert.deepEqual(after.days.find((d) => d.day_of_week === 1).customers.map((c) => c.id), tue);
  assert.deepEqual(after.unplanned.map((c) => c.id), [dropped]);
  // put it back on Saturday
  body.days[6].push(dropped);
  const back = await apiRequest(`/api/route-plan-sets/${setIds[0]}/reps/${repA.id}`, { method: "PUT", cookie: adminCookie, body });
  assert.equal(repOf(back.data, repA).unplanned.length, 0);
});

test("duplicate (save as new plan), rename, change frequency of the whole plan", async () => {
  const dup = await apiRequest(`/api/route-plan-sets/${setIds[0]}/duplicate`, { method: "POST", cookie: adminCookie, body: { name: "T7" } });
  assert.equal(dup.status, 201);
  setIds.push(dup.data.id);
  assert.equal(dup.data.name, "T7");
  assert.equal(dup.data.is_active, false);
  const freq = await apiRequest(`/api/route-plan-sets/${dup.data.id}`, { method: "PATCH", cookie: adminCookie, body: { frequency_days: 7, name: "T7b" } });
  assert.equal(freq.data.name, "T7b");
  assert.ok(repOf(freq.data, repA).days.flatMap((d) => d.customers).every((c) => c.frequency_days === 7));
  const orig = await apiRequest(`/api/route-plan-sets/${setIds[0]}`, { cookie: adminCookie });
  assert.ok(repOf(orig.data, repA).days.flatMap((d) => d.customers).every((c) => c.frequency_days === 14), "the original keeps its own frequency");
});

test("activate: rules + frequencies go live; switching back restores them; the active plan cannot be deleted", async () => {
  const live = async (user) => (await pool.query("SELECT day_of_week, customer_ids FROM visit_plan_rules WHERE user_id = $1 AND active ORDER BY day_of_week", [user.id])).rows;
  // (custA[0] is taken off the plan by hand below, so it is not part of what a plan's frequency controls)
  const freqs = async () => (await pool.query("SELECT DISTINCT visit_frequency_days FROM customers WHERE id = ANY($1)", [custA.slice(1).map((c) => c.id)])).rows.map((r) => r.visit_frequency_days);
  const act = await apiRequest(`/api/route-plan-sets/${setIds[0]}/activate`, { method: "POST", cookie: adminCookie, body: {} });
  assert.equal(act.status, 200);
  assert.equal(act.data.sets.filter((s) => s.is_active).length, 1);
  assert.ok(act.data.sets.find((s) => s.id === setIds[0]).is_active);
  assert.deepEqual(await freqs(), [14]);
  const rulesA = await live(repA);
  assert.equal(rulesA.flatMap((r) => r.customer_ids).length, 13);
  assert.equal((await live(repB)).flatMap((r) => r.customer_ids).length, 4);
  // a manual change on the old screens while the plan is active is kept when switching away
  await pool.query("UPDATE visit_plan_rules SET customer_ids = array_remove(customer_ids, $2) WHERE user_id = $1", [repA.id, custA[0].id]);
  assert.equal((await apiRequest(`/api/route-plan-sets/${setIds[0]}`, { method: "DELETE", cookie: adminCookie })).status, 409);
  await apiRequest(`/api/route-plan-sets/${setIds[1]}/activate`, { method: "POST", cookie: adminCookie, body: {} });
  assert.deepEqual(await freqs(), [7]);
  const first = (await apiRequest(`/api/route-plan-sets/${setIds[0]}`, { cookie: adminCookie })).data;
  assert.ok(repOf(first, repA).unplanned.some((c) => c.id === custA[0].id), "the live edit was saved into the plan being left");
  await apiRequest(`/api/route-plan-sets/${setIds[0]}/activate`, { method: "POST", cookie: adminCookie, body: {} });
  assert.deepEqual(await freqs(), [14], "switching back restores the first plan's frequency");
  assert.equal((await live(repA)).flatMap((r) => r.customer_ids).length, 12);
  assert.equal((await apiRequest(`/api/route-plan-sets/${setIds[1]}`, { method: "DELETE", cookie: adminCookie })).status, 204);
  setIds.pop();
});

test("snapshot saves the live plan as a set; deleting a customer removes it from sets", async () => {
  const snap = await apiRequest("/api/route-plan-sets/snapshot", { method: "POST", cookie: adminCookie, body: { name: "Snap" } });
  assert.equal(snap.status, 201);
  assert.equal(snap.data.kind, "snapshot");
  assert.equal(repOf(snap.data, repB).days.flatMap((d) => d.customers).length, 4);
  await pool.query("UPDATE route_plan_set_rules SET customer_ids = array_remove(customer_ids, $1) WHERE set_id = $2", [custB[0].id, snap.data.id]);
  const list = await apiRequest("/api/route-plan-sets", { cookie: adminCookie });
  assert.ok(list.data.some((s) => s.id === snap.data.id && s.customer_count >= 16));
});
