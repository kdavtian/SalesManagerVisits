const EARTH_RADIUS_METERS = 6371000;

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

// Haversine great-circle distance between two lat/lng points, in meters.
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

// A phone's GPS fix is a circle (accuracy_m), not a point: the rep may really be up to that much closer. The
// Check-in allowance forgives it, capped so a very coarse fix cannot excuse any distance.
export const ACCURACY_CREDIT_CAP_M = 100;
export function creditedDistanceMeters(distanceMeters, accuracyMeters) {
  const credit = Number.isFinite(accuracyMeters) && accuracyMeters > 0 ? Math.min(accuracyMeters, ACCURACY_CREDIT_CAP_M) : 0;
  return Math.max(0, distanceMeters - credit);
}
