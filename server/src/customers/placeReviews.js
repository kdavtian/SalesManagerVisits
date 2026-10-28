// Saving a customer's region / subregion: the typed text is matched against the Armenian places (places.js), the right English name is saved, and
// anything we could not place with confidence is queued in place_reviews for a person to look at (owner, 2026-10-25).
import { resolvePlaces } from "./places.js";
import { rolesWhere, reviewsPlaces } from "../shared/roles.js";

export const PLACE_REVIEW_ROLES = rolesWhere(reviewsPlaces);

const blank = (v) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim());

// `incoming`: the fields being written (undefined = not touched); `current`: what the customer has now (context only).
// Returns { values: { region?, subregion? } to write, resolved }.
export function normalizeIncomingPlaces(incoming, current = {}) {
  const regionIn = incoming.region !== undefined;
  const subIn = incoming.subregion !== undefined;
  if (!regionIn && !subIn) return { values: {}, resolved: null };
  const resolved = resolvePlaces({
    region: regionIn ? blank(incoming.region) : current.region,
    subregion: subIn ? blank(incoming.subregion) : current.subregion,
  });
  const values = {};
  if (regionIn) values.region = blank(resolved.region);
  if (subIn) values.subregion = blank(resolved.subregion);
  // a place typed alone filled in its marz, but never overwrite a region somebody already chose
  if (!regionIn && !current.region && resolved.region && resolved.region !== blank(current.region)) values.region = resolved.region;
  return { values, resolved, touched: { region: regionIn, subregion: subIn } };
}

// Queues what needs a person's eye and closes reviews that are no longer true. db: pool or a client.
export async function recordPlaceReviews(db, customerId, userId, outcome) {
  const { resolved, touched, values } = outcome;
  if (!resolved) return;
  for (const field of ["region", "subregion"]) {
    if (!touched?.[field]) continue;
    const unknown = resolved.unknown.find((u) => u.field === field);
    const near = resolved.changed.find((c) => c.field === field && c.how === "near");
    if (unknown || near) {
      const kind = unknown ? (unknown.reason === "other_region" ? "other_region" : "unknown") : "corrected";
      const typed = unknown ? unknown.typed : near.from;
      const applied = values[field] ?? "";
      await db.query(
        `INSERT INTO place_reviews (customer_id, field, typed_value, applied_value, kind, suggestions, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (customer_id, field) WHERE status = 'pending'
         DO UPDATE SET typed_value = EXCLUDED.typed_value, applied_value = EXCLUDED.applied_value, kind = EXCLUDED.kind,
                       suggestions = EXCLUDED.suggestions, created_by = EXCLUDED.created_by, created_at = now()`,
        [customerId, field, typed, applied, kind, JSON.stringify(unknown?.suggestions ?? []), userId ?? null]
      );
    } else {
      await db.query(
        `UPDATE place_reviews SET status = 'resolved', resolution = 'fixed_by_edit', resolved_at = now(), resolved_by = $3
         WHERE customer_id = $1 AND field = $2 AND status = 'pending'`,
        [customerId, field, userId ?? null]
      );
    }
  }
}

// What the person gets back after a save, to tell them in one line.
export function placeNotice(outcome) {
  const r = outcome?.resolved;
  if (!r) return null;
  const changed = r.changed.filter((c) => c.how !== "region_from_place" || true).map((c) => ({ field: c.field, from: c.from, to: c.to, how: c.how }));
  const unknown = r.unknown.map((u) => ({ field: u.field, typed: u.typed, reason: u.reason ?? "unknown", suggestions: u.suggestions }));
  if (!changed.length && !unknown.length) return null;
  return { changed, unknown };
}
