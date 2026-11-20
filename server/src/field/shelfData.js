// The products on a shop's shelf (owner, 2026-11-20): every visit can record Castrol / Lotos / Royal and the competitors (checkins.brand_status).
// A visit RECORDED the shelf when it holds at least one of those groups, or the competitors' bottles / drum / not-available answers. A visit
// that could not look at the shelf records { shelf_skipped: { reason } } instead, which is not shelf data: the next visit asks again.
// The check-in screen asks for it: a highlighted reminder at the first visit of a shop with no shelf data; required once a shop still has none
// after a visit, or its last shelf data is older than SHELF_FRESH_DAYS. Management sees each rep's share of visited shops with fresh data.
export const SHELF_FRESH_DAYS = 60;
export const SHELF_GROUPS = ["castrol", "lotos", "royal", "competitors"];

// SQL: this check-in (alias) recorded the shelf
export function shelfRecordedSql(alias = "ch") {
  return `(${alias}.brand_status IS NOT NULL AND (
    EXISTS (SELECT 1 FROM unnest(ARRAY['${SHELF_GROUPS.join("','")}']) AS sg(k)
            WHERE jsonb_typeof(${alias}.brand_status -> sg.k) = 'array' AND jsonb_array_length(${alias}.brand_status -> sg.k) > 0)
    OR jsonb_typeof(${alias}.brand_status -> 'competitor_packs') = 'object'))`;
}

// The reason a visit could not look at the shelf: trimmed text, 3..300 characters, or null
export function parseShelfSkipped(value) {
  const reason = typeof value?.reason === "string" ? value.reason.trim().slice(0, 300) : "";
  return reason.length >= 3 ? { reason } : null;
}
