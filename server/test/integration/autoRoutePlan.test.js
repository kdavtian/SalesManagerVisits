// A new customer joins its rep's route plan by itself (owner, 2026-11-03: "if Artak has to visit most of the Abovyan customers on
// Tuesday and a new Abovyan customer is added, it is added to that plan"): the day with most of the rep's customers of that subregion,
// after the nearest of them; a day that plans the whole area already includes it; never for unvisited channels or when switched off.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs, trackCustomer } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { chooseDay } from "../../src/field/autoRoutePlan.js";

let admin, rep, cookies, ids;
const AREA = { region: "Kotayk", subregion: "Abovyan" };

async function shop(name, place, lat, lng) {
  const c = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id, name });
  await pool.query("UPDATE customers SET region = $2, subregion = $3, lat = $4, lng = $5 WHERE id = $1", [c.id, place.region, place.subregion, lat, lng]);
  return c.id;
}
const rule = (dow) => pool.query("SELECT customer_ids, areas FROM visit_plan_rules WHERE user_id = $1 AND day_of_week = $2", [rep.id, dow]).then((r) => r.rows[0]);

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  rep = await createUser("sales_manager");
  cookies = { admin: await loginAs(admin.email), rep: await loginAs(rep.email) };
  // Monday: one Abovyan shop + two Hrazdan shops; Tuesday: three Abovyan shops (the Abovyan day)
  const hrazdan = { region: "Kotayk", subregion: "Hrazdan" };
  ids = {
    mon: [await shop("ITest Ab M", AREA, 40.27, 44.63), await shop("ITest Hr 1", hrazdan, 40.5, 44.76), await shop("ITest Hr 2", hrazdan, 40.51, 44.77)],
    tue: [await shop("ITest Ab 1", AREA, 40.26, 44.62), await shop("ITest Ab 2", AREA, 40.3, 44.6), await shop("ITest Ab 3", AREA, 40.25, 44.64)],
  };
  for (const [dow, list] of [[1, ids.mon], [2, ids.tue]]) {
    await pool.query("INSERT INTO visit_plan_rules (user_id, day_of_week, areas, customer_ids, created_by, active) VALUES ($1, $2, '[]', $3, $1, true)", [rep.id, dow, list]);
  }
});
test.after(async () => {
  await pool.query("DELETE FROM visit_plan_rules WHERE user_id = $1", [rep.id]);
  await pool.query("UPDATE app_settings SET auto_route_plan_new_customers = true WHERE id = 1");
  await cleanupAll();
  await stopTestServer();
});

const stamp = Date.now().toString(36);
async function add(name, extra = {}) {
  const r = await apiRequest("/api/customers", { method: "POST", cookie: cookies.rep, body: { name: `${name} ${stamp}`, lat: 40.301, lng: 44.601, ...AREA, sales_channel: "SM YVN", ...extra } });
  if (r.data?.id) trackCustomer(r.data.id);
  return r;
}

test("a new Abovyan customer goes onto the Abovyan day (Tuesday), right after the nearest Abovyan shop", async () => {
  const r = await add("ITest New Abovyan");
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.route_plan.status, "added");
  assert.equal(r.data.route_plan.day_of_week, 2);
  assert.equal(r.data.route_plan.by, "subregion");
  assert.equal(r.data.route_plan.area, "Abovyan");
  const tue = await rule(2);
  assert.deepEqual(tue.customer_ids, [ids.tue[0], ids.tue[1], r.data.id, ids.tue[2]], "after the nearest shop (Ab 2)");
  assert.ok(!(await rule(1)).customer_ids.includes(r.data.id));
});

test("a day that plans the whole area already includes it; an unvisited channel and the Off switch leave the plan alone", async () => {
  await pool.query("UPDATE visit_plan_rules SET areas = $2 WHERE user_id = $1 AND day_of_week = 1", [rep.id, JSON.stringify([{ region: "Kotayk", subregion: "Hrazdan" }])]);
  const inArea = await add("ITest New Hrazdan", { subregion: "Hrazdan", lat: 40.5, lng: 44.76 });
  assert.equal(inArea.data.route_plan.status, "in_area");
  assert.equal(inArea.data.route_plan.day_of_week, 1);
  const kf = await add("ITest New KF", { sales_channel: "KF", lat: 40.31, lng: 44.61 });
  assert.deepEqual(kf.data.route_plan, { status: "skipped", reason: "not_visited" });
  // the switch (App configuration): admin only
  assert.equal((await apiRequest("/api/settings", { method: "PATCH", cookie: cookies.rep, body: { auto_route_plan_new_customers: false } })).status, 403);
  const off = await apiRequest("/api/settings", { method: "PATCH", cookie: cookies.admin, body: { auto_route_plan_new_customers: false } });
  assert.equal(off.data.auto_route_plan_new_customers, false);
  const before = (await rule(2)).customer_ids.length;
  const r = await add("ITest New Abovyan off", { lat: 40.32, lng: 44.62 });
  assert.deepEqual(r.data.route_plan, { status: "skipped", reason: "off" });
  assert.equal((await rule(2)).customer_ids.length, before);
});

test("chooseDay: falls back to the region, a tie goes to the lighter day, another plan's (SM B2B) customers do not count", () => {
  const known = new Map([
    [1, { region: "Kotayk", subregion: "Byureghavan", sales_channel: "SM YVN" }],
    [2, { region: "Kotayk", subregion: "Byureghavan", sales_channel: "SM YVN" }],
    [3, { region: "Kotayk", subregion: "Hrazdan", sales_channel: "SM YVN" }],
    [4, { region: "Kotayk", subregion: "Abovyan", sales_channel: "SM B2B" }],
    [5, { region: "Kotayk", subregion: "Abovyan", sales_channel: "SM B2B" }],
    [6, { region: "Lori", subregion: "Vanadzor", sales_channel: "SM YVN" }],
  ]);
  const c = { region: "Kotayk", subregion: "Abovyan", sales_channel: "SM YVN" };
  const rules = [{ day_of_week: 3, customer_ids: [1, 2] }, { day_of_week: 4, customer_ids: [3] }, { day_of_week: 5, customer_ids: [4, 5] }];
  // no SM YVN Abovyan shop anywhere -> by region; Wednesday (2 Kotayk) beats Thursday (1)
  assert.deepEqual(chooseDay(c, rules, known), { day_of_week: 3, by: "region", count: 2, index: 2 });
  // a tie: the lighter day wins
  const tie = [{ day_of_week: 3, customer_ids: [1, 6] }, { day_of_week: 4, customer_ids: [2] }];
  assert.equal(chooseDay(c, tie, known).day_of_week, 4);
  assert.equal(chooseDay({ ...c, region: "Lori", subregion: "Vanadzor" }, rules, known), null);
});
