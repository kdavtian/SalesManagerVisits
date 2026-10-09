// Fuel allowance report: km between the day's check-ins, home legs for days
// outside Yerevan, fuel litres/AMD, corrections and who may see/change what.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, loginAs, apiRequest, trackCheckin } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { setRouteProvider } from "../../src/fuelRoute.js";

const MONTH = "2031-03";
test.before(startTestServer);
test.after(async () => {
  setRouteProvider(null);
  await pool.query("DELETE FROM fuel_prices WHERE month = '2031-03-01'");
  await cleanupAll();
  await stopTestServer();
});

async function checkin(user, customer, iso, lat, lng, withinRange = true) {
  const { rows } = await pool.query(
    "INSERT INTO checkins (customer_id, user_id, timestamp, lat, lng, distance_meters, within_range) VALUES ($1, $2, $3, $4, $5, 10, $6) RETURNING id",
    [customer.id, user.id, iso, lat, lng, withinRange]
  );
  return trackCheckin(rows[0].id);
}

test("daily km, home legs, fuel cost, corrections and permissions", async () => {
  // Every leg is 10 km for the test (the routing engine is stubbed).
  setRouteProvider(async (points) => ({ km: points.slice(1).map(() => 10), source: "osrm" }));

  const rep = await createUser("sales_manager");
  const admin = await createUser("admin");
  const accountant = await createUser("accountant");
  const director = await createUser("sales_director");
  await pool.query("UPDATE users SET fuel_l_per_100km = 10, home_lat = 40.17, home_lng = 44.49, home_address = 'Home St 1' WHERE id = $1", [rep.id]);
  const cYer1 = await createCustomer({ created_by: rep.id });
  const cYer2 = await createCustomer({ created_by: rep.id });
  const cShirak = await createCustomer({ created_by: rep.id });
  await pool.query("UPDATE customers SET region = 'Yerevan' WHERE id = ANY($1)", [[cYer1.id, cYer2.id]]);
  await pool.query("UPDATE customers SET region = 'Shirak' WHERE id = $1", [cShirak.id]);

  // Monday 3 March 2031 in Yerevan: two city visits + one bad GPS check-in -> 1 leg of 10 km.
  await checkin(rep, cYer1, "2031-03-03T05:00:00Z", 40.18, 44.5);
  await checkin(rep, cYer2, "2031-03-03T07:00:00Z", 40.2, 44.54);
  await checkin(rep, cYer2, "2031-03-03T08:00:00Z", 41.5, 45.5, false);
  // Tuesday: one stop in Shirak -> home -> stop -> home = 2 legs of 10 km.
  await checkin(rep, cShirak, "2031-03-04T06:00:00Z", 40.78, 43.84);

  const adminCookie = await loginAs(admin.email);
  const noPrice = await apiRequest(`/api/fuel/report?month=${MONTH}`, { cookie: adminCookie });
  assert.equal(noPrice.status, 200);
  assert.equal(noPrice.data.price_amd_per_l, null);

  assert.equal((await apiRequest(`/api/fuel/prices/${MONTH}`, { method: "PUT", cookie: adminCookie, body: { price_amd_per_l: 400 } })).status, 200);
  const report = (await apiRequest(`/api/fuel/report?month=${MONTH}`, { cookie: adminCookie })).data;
  const mine = report.reps.find((r) => r.user_id === rep.id);
  const monday = mine.days.find((d) => d.date === "2031-03-03");
  const tuesday = mine.days.find((d) => d.date === "2031-03-04");
  assert.equal(monday.km, 10);
  assert.equal(monday.skipped.length, 1);
  assert.equal(monday.liters, 1);
  assert.equal(monday.amount, 400);
  assert.deepEqual(tuesday.route.map((p) => p.type), ["home", "checkin", "home"]);
  assert.equal(tuesday.km, 20);
  assert.equal(mine.totals.km, 30);
  assert.equal(mine.totals.amount, 1200);

  // A correction replaces the computed distance.
  assert.equal((await apiRequest("/api/fuel/overrides", { method: "PUT", cookie: adminCookie, body: { user_id: rep.id, day: "2031-03-04", km: 12.5, note: "checked" } })).status, 204);
  const corrected = (await apiRequest(`/api/fuel/report?month=${MONTH}`, { cookie: adminCookie })).data.reps.find((r) => r.user_id === rep.id);
  assert.equal(corrected.days.find((d) => d.date === "2031-03-04").km, 12.5);
  assert.equal(corrected.days.find((d) => d.date === "2031-03-04").computed_km, 20);

  // Accountant and director can see, only admin/ceo can change; a rep sees nothing.
  const accCookie = await loginAs(accountant.email);
  assert.equal((await apiRequest(`/api/fuel/report?month=${MONTH}`, { cookie: accCookie })).status, 200);
  assert.equal((await apiRequest(`/api/fuel/prices/${MONTH}`, { method: "PUT", cookie: accCookie, body: { price_amd_per_l: 1 } })).status, 403);
  const dirCookie = await loginAs(director.email);
  assert.equal((await apiRequest(`/api/fuel/settings/users/${rep.id}`, { method: "PUT", cookie: dirCookie, body: { fuel_l_per_100km: 5 } })).status, 403);
  const repCookie = await loginAs(rep.email);
  assert.equal((await apiRequest(`/api/fuel/report?month=${MONTH}`, { cookie: repCookie })).status, 403);

  // Settings validation.
  assert.equal((await apiRequest(`/api/fuel/settings/users/${rep.id}`, { method: "PUT", cookie: adminCookie, body: { fuel_l_per_100km: 99 } })).status, 400);
  assert.equal((await apiRequest(`/api/fuel/settings/users/${rep.id}`, { method: "PUT", cookie: adminCookie, body: { home_lat: 40.1 } })).status, 400);
  const saved = await apiRequest(`/api/fuel/settings/users/${rep.id}`, { method: "PUT", cookie: adminCookie, body: { fuel_l_per_100km: 8.5 } });
  assert.equal(saved.status, 200);
  assert.equal(Number(saved.data.fuel_l_per_100km), 8.5);

  const csv = await apiRequest(`/api/fuel/report.csv?month=${MONTH}`, { cookie: adminCookie });
  assert.equal(csv.status, 200);
  assert.match(String(csv.data), /TOTAL/);
});
