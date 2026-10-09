// Fuel allowance maths: which of a rep's check-ins form the day's route, the
// legs between them (plus home legs for days that start/end outside Yerevan)
// and the road distance of each leg. Pure functions + a routing client; the
// database side lives in fuelReport.js.
import crypto from "node:crypto";
import { haversineMeters } from "./osrm.js";

export const YEREVAN_CENTER = { lat: 40.1792, lng: 44.4991 };
export const YEREVAN_RADIUS_KM = 13; // used only when the customer has no region on file
export const SAME_PLACE_KM = 0.15; // check-ins closer than this are one stop
// Driving inside this radius of the centre is "city" (stop-and-go, higher
// consumption); everything outside it is "highway". Yerevan's built-up area is
// roughly this size -- a deliberate approximation, the owner can correct a day.
export const CITY_RADIUS_KM = Number(process.env.FUEL_CITY_RADIUS_KM) || 10;
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

const inCity = (p) => haversineKm(p, YEREVAN_CENTER) <= CITY_RADIUS_KM;

// Share (0..1) of the straight line a -> b that lies inside the city circle.
export function cityShare(a, b, samples = 80) {
  let inside = 0;
  for (let i = 0; i < samples; i++) {
    const f = (i + 0.5) / samples;
    if (inCity({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f })) inside++;
  }
  return inside / samples;
}

// Share of a real road geometry ([[lng, lat], ...]) inside the city circle.
function pathCityShare(coords) {
  let total = 0;
  let city = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = { lat: coords[i - 1][1], lng: coords[i - 1][0] };
    const b = { lat: coords[i][1], lng: coords[i][0] };
    const len = haversineKm(a, b);
    total += len;
    if (inCity({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 })) city += len;
  }
  return total > 0 ? city / total : 0;
}

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
  // "v2": cached legs carry their city share (older entries are plain km).
  const s = "v2|" + points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join(";");
  return crypto.createHash("sha1").update(s).digest("hex");
}

// Legs are { km, city } -- road km of the leg and how many of them are city.
export function estimateLegs(points) {
  const legs = [];
  for (let i = 1; i < points.length; i++) {
    const km = haversineKm(points[i - 1], points[i]) * ROAD_FACTOR;
    legs.push({ km, city: km * cityShare(points[i - 1], points[i]) });
  }
  return legs;
}

// A routing answer that only has km (a test stub) gets its city share from the straight line.
function withCityShare(points, km) {
  return km.map((k, i) => ({ km: k, city: k * cityShare(points[i], points[i + 1]) }));
}

// Road distances (km) of the legs between consecutive points, from the
// self-hosted OSRM first, then the public demo server. Returns
// { legs: [{ km, city }], source: "osrm" } or null when no engine answered.
const ROUTER_URLS = () => (process.env.FUEL_OSRM_URLS ? process.env.FUEL_OSRM_URLS.split(",") : [process.env.OSRM_URL || "http://localhost:5001", "https://router.project-osrm.org"]).map((u) => u.trim()).filter(Boolean);

let routeProvider = null; // tests inject a stub
export function setRouteProvider(fn) {
  routeProvider = fn;
}

export async function fetchRoadLegsKm(points) {
  if (routeProvider) {
    const res = await routeProvider(points);
    if (!res) return null;
    return res.legs ? res : { legs: withCityShare(points, res.km), source: res.source ?? "osrm" };
  }
  if (process.env.NODE_ENV === "test") return null; // never touch the network in tests
  if (points.length < 2) return { legs: [], source: "osrm" };
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  for (const base of ROUTER_URLS()) {
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/route/v1/driving/${coords}?overview=false&steps=true&geometries=geojson`, {
        signal: AbortSignal.timeout(4000),
        headers: { "User-Agent": "KAD-Motors-FieldVisits/1.0 (fuel allowance)" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const legs = data?.routes?.[0]?.legs;
      if (data.code !== "Ok" || !Array.isArray(legs) || legs.length !== points.length - 1) continue;
      return {
        legs: legs.map((l) => {
          const km = l.distance / 1000;
          // City km from the real road geometry, step by step.
          let city = 0;
          for (const step of l.steps ?? []) city += (step.distance / 1000) * pathCityShare(step.geometry?.coordinates ?? []);
          return { km, city: Math.min(km, city) };
        }),
        source: "osrm",
      };
    } catch {
      // try the next engine
    }
  }
  return null;
}

// ---- background road-distance fetching --------------------------------------
// The report never waits on the routing engine for long: missing days are
// fetched in the background (a few at a time, remembered in fuel_route_cache by
// the caller) and the report answers at once with estimates for them. A route
// that no engine could answer is not retried for 10 minutes, and after a streak
// of failures the engine is left alone for a minute (so a dead engine cannot
// pile up timeouts behind every page load).
const CONCURRENCY = 3;
const FAIL_TTL_MS = 10 * 60 * 1000;
let active = 0;
const waiting = [];
const inflight = new Map();
const failedAt = new Map();
let failStreak = 0;
let pausedUntil = 0;

function acquire() {
  return new Promise((resolve) => {
    if (active < CONCURRENCY) {
      active++;
      resolve();
    } else waiting.push(resolve);
  });
}
function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

export function resetRouteState() {
  inflight.clear();
  failedAt.clear();
  failStreak = 0;
  pausedUntil = 0;
}

// Forget recent failures so the next report asks the routing engine again.
export function retryFailedRoutes() {
  failedAt.clear();
  failStreak = 0;
  pausedUntil = 0;
}

// "pending" = being fetched now, "failed" = no engine answered recently, "idle" = not asked yet.
export function routeState(key) {
  if (inflight.has(key)) return "pending";
  const f = failedAt.get(key);
  if ((f && Date.now() - f < FAIL_TTL_MS) || Date.now() < pausedUntil) return "failed";
  return "idle";
}

// Starts (or joins) the fetch of one route; resolves to the legs, or null.
// onSuccess({ km, source }) runs before it resolves (the caller caches it).
export function requestRoute(key, points, onSuccess) {
  if (inflight.has(key)) return inflight.get(key);
  if (routeState(key) === "failed") return Promise.resolve(null);
  const promise = (async () => {
    await acquire();
    try {
      const res = await fetchRoadLegsKm(points);
      if (res) {
        failStreak = 0;
        await onSuccess?.(res);
        return res.legs;
      }
      failedAt.set(key, Date.now());
      if (++failStreak >= 6) pausedUntil = Date.now() + 60 * 1000;
      return null;
    } catch {
      failedAt.set(key, Date.now());
      return null;
    } finally {
      release();
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

// Fuel for a day: city km at the city consumption, highway km at the (lower)
// highway consumption. A missing figure falls back to the other one.
export function fuelFor(cityKm, highwayKm, cityL100, highwayL100, pricePerL) {
  const city = cityL100 ?? highwayL100;
  const highway = highwayL100 ?? cityL100;
  if (city == null) return { liters: null, amount: null };
  const liters = (cityKm * city + highwayKm * highway) / 100;
  return { liters: round1(liters), amount: pricePerL != null ? Math.round(liters * pricePerL) : null };
}

export { round1 };
