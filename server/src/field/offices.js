// Offices (owner, 2026-11-03): customers with checkin_for_all are check-in places for every rep (Head office, the second office...).
// When a rep's phone reports a position near one, the answer to that very request carries "you are at <office>" so the app can offer the
// check-in (no extra GPS use: the position comes from the foreground ping that already runs).
import { haversineMeters } from "../utils/geo.js";

export const OFFICE_RADIUS_M = 150;
export const OFFICE_REPROMPT_HOURS = 4; // once checked in at an office, no new suggestion for this long

// Returns { id, name, distance_m } of the nearest office within the radius that the person has not checked in at recently, else null.
export async function officeNear(db, userId, lat, lng) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.lat, c.lng FROM customers c
     WHERE c.checkin_for_all AND c.lat IS NOT NULL AND c.lng IS NOT NULL
       AND c.lat BETWEEN $1 - 0.01 AND $1 + 0.01 AND c.lng BETWEEN $2 - 0.01 AND $2 + 0.01
       AND NOT EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.user_id = $3 AND ch.timestamp > now() - make_interval(hours => $4))`,
    [lat, lng, userId, OFFICE_REPROMPT_HOURS]
  );
  let best = null;
  for (const o of rows) {
    const d = haversineMeters(lat, lng, o.lat, o.lng);
    if (d <= OFFICE_RADIUS_M && (!best || d < best.distance_m)) best = { id: o.id, name: o.name, distance_m: Math.round(d) };
  }
  return best;
}
