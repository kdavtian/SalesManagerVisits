// Pin review: customers whose PIN is probably wrong -- as opposed to a rep whose GPS was off.
// Evidence = where sales managers really stood, farther than the Check-in allowance from the pin:
//   * saved check-ins made far from the pin (history from before the allowance), and
//   * refused attempts (checkin_far_attempts: the rep stood at the shop and the app said "too far").
// Signal (owner, 2026-10-13): two or more such points within CLUSTER_RADIUS_M of each other, all farther than
// the allowance from the pin. Only evidence after the pin was last moved / the review was dismissed counts.
import { pool } from "../db/pool.js";
import { haversineMeters } from "../utils/geo.js";
import { getCheckinRadiusMeters } from "../shared/settings.js";
import { FIELD_REP_ROLE } from "../field/visitCount.js";

export const CLUSTER_RADIUS_M = 60;
export const MIN_CLUSTER_POINTS = 2;
const EVIDENCE_DAYS = 180;
const MAX_ACCURACY_M = 100; // a fix worse than this says little about where the rep was
const SAME_VISIT_MS = 5 * 60 * 1000; // two points of one rep within 5 min are one visit (double tap, retry)

// points: [{ user_id, lat, lng, at (ms) }] -> { points, users, lat, lng } | null
// The densest group: the point with most neighbours within CLUSTER_RADIUS_M, then its centroid.
export function findPinCluster(rawPoints) {
  const sorted = [...rawPoints].sort((a, b) => a.at - b.at);
  const points = [];
  for (const p of sorted) {
    if (points.some((q) => q.user_id === p.user_id && Math.abs(q.at - p.at) < SAME_VISIT_MS)) continue;
    points.push(p);
  }
  let best = null;
  for (const center of points) {
    const group = points.filter((q) => haversineMeters(center.lat, center.lng, q.lat, q.lng) <= CLUSTER_RADIUS_M);
    if (!best || group.length > best.length) best = group;
  }
  if (!best || best.length < MIN_CLUSTER_POINTS) return null;
  const lat = best.reduce((s, p) => s + p.lat, 0) / best.length;
  const lng = best.reduce((s, p) => s + p.lng, 0) / best.length;
  const group = best.filter((q) => haversineMeters(lat, lng, q.lat, q.lng) <= CLUSTER_RADIUS_M);
  if (group.length < MIN_CLUSTER_POINTS) return null;
  return { points: group.length, users: new Set(group.map((p) => p.user_id)).size, lat, lng, last_at: Math.max(...group.map((p) => p.at)) };
}

// customerId: only that customer (for accept); otherwise every customer with evidence.
export async function buildPinReview(customerId = null) {
  const allowance = await getCheckinRadiusMeters();
  const params = [allowance, EVIDENCE_DAYS, FIELD_REP_ROLE];
  let only = "";
  if (customerId) {
    params.push(customerId);
    only = `AND c.id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `WITH ev AS (
       SELECT ch.customer_id, ch.user_id, ch.lat, ch.lng, ch.timestamp AS at, ch.distance_meters, ch.accuracy_m
       FROM checkins ch JOIN users u ON u.id = ch.user_id AND u.role = $3
       WHERE NOT ch.within_range
       UNION ALL
       SELECT a.customer_id, a.user_id, a.lat, a.lng, a.created_at, a.distance_meters, a.accuracy_m
       FROM checkin_far_attempts a JOIN users u ON u.id = a.user_id AND u.role = $3
     )
     SELECT ev.customer_id, ev.user_id, ev.lat, ev.lng, ev.at, c.name, c.region, c.lat AS pin_lat, c.lng AS pin_lng,
            c.assigned_manager_id, m.name AS manager_name,
            (SELECT count(*)::int FROM checkins ic JOIN users iu ON iu.id = ic.user_id AND iu.role = $3
              WHERE ic.customer_id = c.id AND ic.within_range
                AND ic.timestamp > COALESCE(GREATEST(c.pin_set_at, d.dismissed_at), '-infinity'::timestamptz)) AS in_range_since
     FROM ev
     JOIN customers c ON c.id = ev.customer_id
     LEFT JOIN users m ON m.id = c.assigned_manager_id
     LEFT JOIN pin_review_dismissals d ON d.customer_id = c.id
     WHERE ev.distance_meters > $1
       AND ev.at > now() - ($2 || ' days')::interval
       AND ev.at > COALESCE(GREATEST(c.pin_set_at, d.dismissed_at), '-infinity'::timestamptz)
       AND (ev.accuracy_m IS NULL OR ev.accuracy_m <= ${MAX_ACCURACY_M})
       AND NOT COALESCE(c.checkin_for_all, false)
       ${only}`,
    params
  );
  const byCustomer = new Map();
  for (const r of rows) {
    if (!byCustomer.has(r.customer_id)) byCustomer.set(r.customer_id, { info: r, points: [] });
    byCustomer.get(r.customer_id).points.push({ user_id: r.user_id, lat: r.lat, lng: r.lng, at: new Date(r.at).getTime() });
  }
  const out = [];
  for (const { info, points } of byCustomer.values()) {
    const cluster = findPinCluster(points);
    if (!cluster) continue;
    // Reps also checked in AT the pin since it was set: mixed evidence, the pin is probably fine.
    if (info.in_range_since >= cluster.points) continue;
    const shift = Math.round(haversineMeters(info.pin_lat, info.pin_lng, cluster.lat, cluster.lng));
    out.push({
      customer_id: info.customer_id,
      name: info.name,
      region: info.region,
      manager_name: info.manager_name,
      pin_lat: info.pin_lat,
      pin_lng: info.pin_lng,
      suggested_lat: cluster.lat,
      suggested_lng: cluster.lng,
      shift_m: shift,
      points: cluster.points,
      users: cluster.users,
      in_range_since: info.in_range_since,
      last_at: new Date(cluster.last_at).toISOString(),
      confidence: cluster.points >= 3 || cluster.users >= 2 ? "high" : "medium",
    });
  }
  out.sort((a, b) => b.points - a.points || b.shift_m - a.shift_m);
  return out;
}
