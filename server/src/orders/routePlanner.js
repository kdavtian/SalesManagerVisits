// Automatic route planner: spreads one rep's customers over the working days so that
//   * every customer is on exactly one weekday (visited once per cycle),
//   * the days hold a load proportional to their length (a half day, e.g. Saturday, gets half),
//   * each day's customers are close to each other (short driving), and are listed in a sensible visiting order.
// Pure functions (no DB), so they are easy to test. Coordinates are lat/lng degrees.

const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LNG = 111320;

export function distM(a, b) {
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lng - a.lng) * M_PER_DEG_LNG * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

export function pathKm(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += distM(points[i - 1], points[i]);
  return m / 1000;
}

// A pin at 0,0 (or missing) is a placeholder, not a place.
export const hasLocation = (c) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && !(Math.abs(c.lat) < 0.0001 && Math.abs(c.lng) < 0.0001);

// n items over days with the given weights, whole numbers that sum to n (largest remainder).
export function splitCapacities(n, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (!total) return weights.map(() => 0);
  const exact = weights.map((w) => (n * w) / total);
  const caps = exact.map(Math.floor);
  let left = n - caps.reduce((s, c) => s + c, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    caps[i]++;
    left--;
  }
  return caps;
}

// Direction in which the points are most spread out (first principal axis of the cloud), as a unit vector in meters.
function mainAxis(points) {
  const xs = points.map((p) => p.lng * M_PER_DEG_LNG * Math.cos((p.lat * Math.PI) / 180));
  const ys = points.map((p) => p.lat * M_PER_DEG_LAT);
  const mx = xs.reduce((s, v) => s + v, 0) / points.length;
  const my = ys.reduce((s, v) => s + v, 0) / points.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < points.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { ux: Math.cos(angle), uy: Math.sin(angle), xs, ys, mx, my };
}

const projection = (points) => {
  const { ux, uy, xs, ys, mx, my } = mainAxis(points);
  return points.map((_, i) => (xs[i] - mx) * ux + (ys[i] - my) * uy);
};

// Cuts the customers into consecutive day groups of the given sizes: split along the main axis of the cloud so each
// group is a compact area, then recurse into both halves. Days next to each other in the list end up next to each
// other on the map.
function partition(points, caps) {
  if (caps.length === 1) return [points];
  const mid = Math.floor(caps.length / 2);
  const leftCap = caps.slice(0, mid).reduce((s, c) => s + c, 0);
  let sorted = points;
  if (points.length > 1) {
    const proj = projection(points);
    sorted = points.map((p, i) => ({ p, v: proj[i] })).sort((a, b) => a.v - b.v || a.p.id - b.p.id).map((o) => o.p);
  }
  return [...partition(sorted.slice(0, leftCap), caps.slice(0, mid)), ...partition(sorted.slice(leftCap), caps.slice(mid))];
}

// Visiting order inside one day: start at the far end of the area, always go to the nearest unvisited customer,
// then shorten the path with 2-opt swaps.
export function orderStops(points) {
  if (points.length <= 2) return [...points];
  const proj = projection(points);
  let start = 0;
  for (let i = 1; i < points.length; i++) if (proj[i] < proj[start]) start = i;
  const left = points.filter((_, i) => i !== start);
  const path = [points[start]];
  while (left.length) {
    const last = path[path.length - 1];
    let best = 0;
    for (let i = 1; i < left.length; i++) if (distM(last, left[i]) < distM(last, left[best])) best = i;
    path.push(left.splice(best, 1)[0]);
  }
  let improved = true;
  let rounds = 0;
  while (improved && rounds++ < 30) {
    improved = false;
    for (let i = 1; i < path.length - 1; i++) {
      for (let j = i + 1; j < path.length; j++) {
        const before = distM(path[i - 1], path[i]) + (j + 1 < path.length ? distM(path[j], path[j + 1]) : 0);
        const after = distM(path[i - 1], path[j]) + (j + 1 < path.length ? distM(path[i], path[j + 1]) : 0);
        if (after + 1e-6 < before) {
          path.splice(i, j - i + 1, ...path.slice(i, j + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return path;
}

// customers: [{id, lat, lng}], days: [{dow, weight}] in week order (weight 1 = full day, 0.5 = half day).
// Returns Map dow -> ordered customer ids.
export function planRep(customers, days) {
  const out = new Map(days.map((d) => [d.dow, []]));
  if (!days.length || !customers.length) return out;
  const located = customers.filter(hasLocation);
  const unlocated = customers.filter((c) => !hasLocation(c));
  const caps = splitCapacities(located.length, days.map((d) => d.weight));
  const groups = partition(located, caps);
  days.forEach((d, i) => out.set(d.dow, orderStops(groups[i]).map((c) => c.id)));
  // customers without a usable pin go to the lightest day (relative to its length), at the end of its list
  for (const c of unlocated.sort((a, b) => a.id - b.id)) {
    let best = days[0];
    for (const d of days) if (out.get(d.dow).length / d.weight < out.get(best.dow).length / best.weight) best = d;
    out.get(best.dow).push(c.id);
  }
  return out;
}
