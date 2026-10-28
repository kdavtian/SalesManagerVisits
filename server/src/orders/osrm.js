// Thin client for the self-hosted OSRM routing engine (see docker-compose
// .yml's "osrm" service), used by the delivery Route Planner. Never a hard
// dependency -- every function here falls back to straight-line (haversine)
// distance if OSRM is unreachable, misconfigured, or hasn't been
// provisioned with a road network yet, so the planner still works on a
// fresh install.
const OSRM_URL = process.env.OSRM_URL || "http://localhost:5001";
const FETCH_TIMEOUT_MS = 4000;
// A rough average delivery-driving speed in Yerevan traffic, used to turn a
// haversine distance into a plausible duration for the fallback path.
const FALLBACK_SPEED_METERS_PER_SEC = 8.3; // ~30 km/h

const EARTH_RADIUS_METERS = 6371000;

export function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Full distance/duration matrix between every pair of points, in the same
// order they were given. Points are {lat, lng}. Returns
// { distances: number[][], durations: number[][], usedOsrm: boolean }.
export async function buildMatrix(points) {
  const n = points.length;
  if (n < 2) {
    return { distances: [[0]], durations: [[0]], usedOsrm: false };
  }

  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const res = await fetchWithTimeout(`${OSRM_URL}/table/v1/driving/${coords}?annotations=distance,duration`);
    if (!res.ok) throw new Error(`OSRM table request failed (${res.status})`);
    const data = await res.json();
    if (data.code !== "Ok" || !data.distances || !data.durations) throw new Error("OSRM table response missing matrices");
    return { distances: data.distances, durations: data.durations, usedOsrm: true };
  } catch {
    // Unreachable, timed out, or not yet provisioned with a road network --
    // fall back to a straight-line matrix so the planner still works.
    const distances = Array.from({ length: n }, () => new Array(n).fill(0));
    const durations = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const d = haversineMeters(points[i].lat, points[i].lng, points[j].lat, points[j].lng);
        distances[i][j] = d;
        durations[i][j] = d / FALLBACK_SPEED_METERS_PER_SEC;
      }
    }
    return { distances, durations, usedOsrm: false };
  }
}

// Nearest-neighbor construction followed by 2-opt improvement, starting
// from index 0 (the driver's depot/starting point) -- returns the visiting
// order as an array of indices into `points`, e.g. [0, 3, 1, 2].
export function optimizeOrder(distanceMatrix) {
  const n = distanceMatrix.length;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);

  // Nearest-neighbor construction.
  const visited = new Set([0]);
  let route = [0];
  let current = 0;
  while (visited.size < n) {
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (visited.has(j)) continue;
      if (distanceMatrix[current][j] < bestDist) {
        bestDist = distanceMatrix[current][j];
        best = j;
      }
    }
    route.push(best);
    visited.add(best);
    current = best;
  }

  // 2-opt: repeatedly reverse a segment if it shortens the total route,
  // stopping when a full pass finds no improvement or after a bounded
  // number of passes (a delivery route is at most a few dozen stops, so
  // this converges almost immediately).
  function routeLength(r) {
    let total = 0;
    for (let i = 0; i < r.length - 1; i++) total += distanceMatrix[r[i]][r[i + 1]];
    return total;
  }

  let improved = true;
  let passes = 0;
  while (improved && passes < 25) {
    improved = false;
    passes++;
    for (let i = 1; i < route.length - 2; i++) {
      for (let k = i + 1; k < route.length - 1; k++) {
        const before =
          distanceMatrix[route[i - 1]][route[i]] + distanceMatrix[route[k]][route[k + 1]];
        const after =
          distanceMatrix[route[i - 1]][route[k]] + distanceMatrix[route[i]][route[k + 1]];
        if (after + 1e-6 < before) {
          const segment = route.slice(i, k + 1).reverse();
          route = [...route.slice(0, i), ...segment, ...route.slice(k + 1)];
          improved = true;
        }
      }
    }
  }
  void routeLength;
  return route;
}
