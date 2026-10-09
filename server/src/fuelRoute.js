// Fuel allowance maths: which of a rep's check-ins form the day's route, the
// legs between them (plus home legs for days that start/end outside Yerevan)
// and the road distance of each leg. Pure functions + a routing client; the
// database side lives in fuelReport.js.
import crypto from "node:crypto";
import { haversineMeters } from "./osrm.js";

export const YEREVAN_CENTER = { lat: 40.1792, lng: 44.4991 };
export const YEREVAN_RADIUS_KM = 13; // used only when the customer has no region on file
export const SAME_PLACE_KM = 0.15; // check-ins closer than this are one stop
const ROAD_FACTOR = Number(process.env.FUEL_ROAD_FACTOR) || 1.3; // straight line -> road, when routing is unreachable

export function haversineKm(a, b) {
  return haversineMeters(a.lat, a.lng, b.lat, b.lng) / 1000;
}

// Is this point in Yerevan? The customer's recorded region wins (Armenian or
// Latin name); without one, a radius around the centre decides.
export function isYerevanPoint(point, region = null) {
  if (region) return /^(yerevan|երևան|ереван)$/i.test(String(region).trim());
  return haversineKm(point, YEREVAN_CENTER) <= YEREVAN_RADIUS_KM;
}

const round1 = (n) => Math.round(n * 10) / 10;

// A rep's check-ins for one Yerevan day -> the stops that count and the ones
// that do not. A check-in made far from its customer (within_range = false)
// is not trusted as a place the rep really was.
export function splitCheckins(checkins) {
  const counted = [];
  const skipped = [];
  for (const c of [...checkins].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))) {
    if (c.within_range === false) skipped.push({ ...c, reason: "far_from_customer" });
    else counted.push(c);
  }
  // Consecutive check-ins at (almost) the same place are one stop.
  const stops = [];
  for (const c of counted) {
    const prev = stops[stops.length - 1];
    if (prev && haversineKm(prev, c) < SAME_PLACE_KM) {
      prev.merged.push(c);
      continue;
    }
    stops.push({ ...c, merged: [] });
  }
  return { stops, skipped };
}

// Waypoints of the day: home -> stops -> home, where home legs exist only
// when the first / last stop is outside Yerevan.
export function buildWaypoints(stops, home) {
  const points = stops.map((s) => ({
    type: "checkin",
    time: s.timestamp,
    name: s.customer_name,
    lat: s.lat,
    lng: s.lng,
    inYerevan: isYerevanPoint(s, s.region),
  }));
  const homeOk = home && Number.isFinite(home.lat) && Number.isFinite(home.lng);
  let missingHome = false;
  if (points.length) {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first.inYerevan) {
      if (homeOk) points.unshift({ type: "home", name: home.address || "", lat: home.lat, lng: home.lng, inYerevan: null });
      else missingHome = true;
    }
    if (!last.inYerevan) {
      if (homeOk) points.push({ type: "home", name: home.address || "", lat: home.lat, lng: home.lng, inYerevan: null, back: true });
      else missingHome = true;
    }
  }
  return { points, missingHome };
}

export function routeKey(points) {
  const s = points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(";");
  return crypto.createHash("sha1").update(s).digest("hex");
}

export function estimateLegsKm(points) {
  const km = [];
  for (let i = 1; i < points.length; i++) km.push(haversineKm(points[i - 1], points[i]) * ROAD_FACTOR);
  return km;
}

// Road distances (km) of the legs between consecutive points, from the
// self-hosted OSRM first, then the public demo server. Returns
// { km: number[], source: "osrm" } or null when no engine answered.
const ROUTER_URLS = () => (process.env.FUEL_OSRM_URLS ? process.env.FUEL_OSRM_URLS.split(",") : [process.env.OSRM_URL || "http://localhost:5001", "https://router.project-osrm.org"]).map((u) => u.trim()).filter(Boolean);

let routeProvider = null; // tests inject a stub
export function setRouteProvider(fn) {
  routeProvider = fn;
}

export async function fetchRoadLegsKm(points) {
  if (routeProvider) return routeProvider(points);
  if (process.env.NODE_ENV === "test") return null; // never touch the network in tests
  if (points.length < 2) return { km: [], source: "osrm" };
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  for (const base of ROUTER_URLS()) {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/route/v1/driving/${coords}?overview=false&steps=false`, {
        signal: AbortSignal.timeout(7000),
        headers: { "User-Agent": "KAD-Motors-FieldVisits/1.0 (fuel allowance)" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const legs = data?.routes?.[0]?.legs;
      if (data.code !== "Ok" || !Array.isArray(legs) || legs.length !== points.length - 1) continue;
      return { km: legs.map((l) => l.distance / 1000), source: "osrm" };
    } catch {
      // try the next engine
    }
  }
  return null;
}

// Fuel for a distance: litres = km x L/100km / 100, cost = litres x price.
export function fuelFor(km, lPer100, pricePerL) {
  const liters = lPer100 != null ? (km * lPer100) / 100 : null;
  const amount = liters != null && pricePerL != null ? Math.round(liters * pricePerL) : null;
  return { liters: liters != null ? round1(liters) : null, amount };
}

export { round1 };
