// GPS evidence for the Bonuses module (migrations/076_bonuses_schema.sql's
// bonus_gps_evidence table) -- every location decision a source contribution
// or attendance record relies on is recorded as its own row here, never a
// bare boolean, so "why did/didn't this qualify" is always answerable later.

// Records the GPS decision a checkin already made for itself (checkins.js
// computes distance_meters/within_range server-side at check-in time -- see
// docs/bonuses-design.md's "GPS reuse" decision -- this just carries that
// same decision into the Bonuses module's own evidence table). `linked`
// distinguishes the checkin's own visit (rule_note "checkins.id=N") from a
// payment borrowing a nearby checkin's evidence (rule_note "linked
// checkins.id=N") -- same row shape either way, different provenance note.
export async function evidenceFromCheckin(client, checkin, { linked = false } = {}) {
  const { rows } = await client.query(
    `INSERT INTO bonus_gps_evidence (lat, lng, distance_meters, within_range, rule_note, captured_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      checkin.lat,
      checkin.lng,
      checkin.distance_meters,
      checkin.within_range,
      `${linked ? "linked " : ""}checkins.id=${checkin.id}`,
      checkin.timestamp,
    ]
  );
  return rows[0];
}

// A payment has no lat/lng of its own (docs/bonuses-design.md: "Collection =
// payments table only" decision) -- GPS validity for a collection instead
// comes from the nearest checkin by the same rep at the same customer,
// within a configurable freshness window ending at the payment's own
// timestamp. Only checkins *at or before* the payment count: the real
// workflow is "visit, collect, log the payment shortly after," never the
// reverse, so a checkin recorded after the payment was logged is never
// treated as evidence for it. Returns the checkin row (with its own
// distance_meters/within_range already computed) or null if nothing
// qualifies within the window.
export async function findNearbyCheckinForLinkage(client, { userId, customerId, occurredAt, freshnessHours }) {
  const { rows } = await client.query(
    `SELECT * FROM checkins
     WHERE user_id = $1 AND customer_id = $2
       AND "timestamp" <= $3
       AND "timestamp" >= $3::timestamptz - ($4 || ' hours')::interval
     ORDER BY "timestamp" DESC
     LIMIT 1`,
    [userId, customerId, occurredAt, freshnessHours]
  );
  return rows[0] ?? null;
}
