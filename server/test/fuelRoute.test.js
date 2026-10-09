import test from "node:test";
import assert from "node:assert/strict";
import { splitCheckins, buildWaypoints, isYerevanPoint, fuelFor, haversineKm, estimateLegsKm } from "../src/fuelRoute.js";

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

test("fuel = km x L/100km x price", () => {
  assert.deepEqual(fuelFor(17, 9, 400), { liters: 1.5, amount: 612 });
  assert.deepEqual(fuelFor(17, null, 400), { liters: null, amount: null });
  assert.deepEqual(fuelFor(17, 9, null), { liters: 1.5, amount: null });
});

test("estimated legs are straight line x road factor", () => {
  const a = { lat: 40.18, lng: 44.5 };
  const b = { lat: 40.28, lng: 44.5 };
  const [km] = estimateLegsKm([a, b]);
  assert.ok(Math.abs(km - haversineKm(a, b) * 1.3) < 1e-9);
});
