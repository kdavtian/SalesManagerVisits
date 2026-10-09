import test from "node:test";
import assert from "node:assert/strict";
import { splitCheckins, buildWaypoints, isYerevanPoint, fuelFor, haversineKm, estimateLegs, cityShare } from "../src/fuelRoute.js";

const ci = (time, lat, lng, extra = {}) => ({ timestamp: `2031-03-03T${time}:00Z`, lat, lng, within_range: true, customer_name: `C${time}`, region: null, ...extra });
const ARAGATS = { lat: 40.9, lng: 44.4 }; // far outside Yerevan

test("Yerevan is decided by the customer's region, else by distance from the centre", () => {
  assert.equal(isYerevanPoint({ lat: 0, lng: 0 }, "Երևան"), true);
  assert.equal(isYerevanPoint({ lat: 40.18, lng: 44.5 }, "Shirak"), false);
  assert.equal(isYerevanPoint({ lat: 40.18, lng: 44.5 }), true);
  assert.equal(isYerevanPoint({ lat: 40.78, lng: 43.84 }), false); // Gyumri
});

test("check-ins far from their customer are not part of the route, same-place ones merge", () => {
  const { stops, skipped } = splitCheckins([
    ci("07:00", 40.18, 44.5),
    ci("07:05", 40.18002, 44.50002), // same place
    ci("08:00", 40.2, 44.52, { within_range: false }),
    ci("09:00", 40.21, 44.54),
  ]);
  assert.equal(stops.length, 2);
  assert.equal(stops[0].merged.length, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "far_from_customer");
});

test("home legs are added only when the day starts / ends outside Yerevan", () => {
  const home = { lat: 40.17, lng: 44.49, address: "home" };
  const inCity = splitCheckins([ci("07:00", 40.18, 44.5), ci("09:00", 40.2, 44.54)]).stops;
  assert.equal(buildWaypoints(inCity, home).points.length, 2);

  const out = splitCheckins([ci("07:00", 40.78, 43.84, { region: "Shirak" }), ci("09:00", 40.79, 43.85, { region: "Shirak" })]).stops;
  const wp = buildWaypoints(out, home);
  assert.deepEqual(wp.points.map((p) => p.type), ["home", "checkin", "checkin", "home"]);

  const mixed = splitCheckins([ci("07:00", 40.18, 44.5), ci("12:00", ARAGATS.lat, ARAGATS.lng, { region: "Aragatsotn" })]).stops;
  assert.deepEqual(buildWaypoints(mixed, home).points.map((p) => p.type), ["checkin", "checkin", "home"]);

  const noHome = buildWaypoints(out, null);
  assert.equal(noHome.missingHome, true);
  assert.equal(noHome.points.length, 2);
});

test("city km use the city consumption, highway km the lower highway one", () => {
  // 10 city km at 10 L/100, 40 highway km at 6 L/100 = 1 + 2.4 litres.
  assert.deepEqual(fuelFor(10, 40, 10, 6, 400), { liters: 3.4, amount: 1360 });
  // Highway figure missing: the city figure is used everywhere.
  assert.deepEqual(fuelFor(10, 40, 10, null, 400), { liters: 5, amount: 2000 });
  // Only a highway figure: used for everything.
  assert.deepEqual(fuelFor(10, 40, null, 6, 400), { liters: 3, amount: 1200 });
  assert.deepEqual(fuelFor(17, 0, null, null, 400), { liters: null, amount: null });
  assert.deepEqual(fuelFor(17, 0, 9, 7, null), { liters: 1.5, amount: null });
});

test("a leg's city share comes from how much of it lies inside Yerevan", () => {
  const inA = { lat: 40.18, lng: 44.5 };
  const inB = { lat: 40.2, lng: 44.54 };
  const farA = { lat: 40.78, lng: 43.84 }; // Gyumri
  const farB = { lat: 40.79, lng: 43.85 };
  assert.equal(cityShare(inA, inB), 1);
  assert.equal(cityShare(farA, farB), 0);
  const mixed = cityShare(inA, farA);
  assert.ok(mixed > 0.05 && mixed < 0.3, `mixed share was ${mixed}`);
  const [leg] = estimateLegs([inA, farA]);
  assert.ok(leg.city > 0 && leg.city < leg.km);
  assert.ok(Math.abs(leg.km - haversineKm(inA, farA) * 1.3) < 1e-9);
});
