// Competitor brands of the check-in shelf (owner, 2026-11-19; migration 215). The list everyone picks from is the approved brands; a rep
// who adds one ("+ Add new brand") can use it at once, and it waits for admin / CEO (the Requests card, system/requests). A denied brand
// leaves the list; visits that recorded it keep its key.
import { pool } from "../db/pool.js";
import { canApproveCompetitorBrands } from "../shared/roles.js";

export class BrandError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// a new brand's key: its name in lower case, spaces -> "_" (any script); the chips show it back without a lookup
export function keyOfName(name) {
  return String(name ?? "")
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[\s\-.]+/g, "_")
    .replace(/[^\p{L}\p{N}_]/gu, "")
    .slice(0, 40);
}
const cleanName = (name) => String(name ?? "").normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 40);

// What a user may pick: the approved brands, plus the ones they asked for that still wait. [{ key, name, status, mine }]
export async function brandsFor(userId, db = pool) {
  const { rows } = await db.query(
    `SELECT key, name, status, requested_by = $1 AS mine FROM competitor_brands
     WHERE status = 'approved' OR (status = 'pending' AND requested_by = $1)
     ORDER BY status = 'pending', sort_order, lower(name)`,
    [userId]
  );
  return rows;
}

// The keys a check-in may record: every approved or waiting brand (another rep's waiting brand too: an offline visit may name it).
export async function recordableKeys(db = pool) {
  const { rows } = await db.query("SELECT key FROM competitor_brands WHERE status IN ('approved', 'pending')");
  return new Set(rows.map((r) => r.key));
}

// A rep adds a brand. The same name already there (any case): that brand is returned, nothing new is asked.
// -> { brand, created }
export async function requestBrand(name, userId, db = pool) {
  const clean = cleanName(name);
  const key = keyOfName(clean);
  if (clean.length < 2 || key.length < 2) throw new BrandError("Write the brand name (2 letters or more)");
  const { rows: [same] } = await db.query("SELECT id, key, name, status, requested_by FROM competitor_brands WHERE key = $1 OR lower(name) = lower($2)", [key, clean]);
  if (same) {
    // a denied brand asked again goes back to the approvers
    if (same.status === "denied") {
      const { rows: [r] } = await db.query(
        `UPDATE competitor_brands SET status = 'pending', requested_by = $2, requested_at = now(), decided_by = NULL, decided_at = NULL, decision_reason = NULL
         WHERE id = $1 RETURNING id, key, name, status`,
        [same.id, userId]
      );
      return { brand: r, created: true };
    }
    return { brand: { id: same.id, key: same.key, name: same.name, status: same.status }, created: false };
  }
  const { rows: [r] } = await db.query(
    "INSERT INTO competitor_brands (key, name, status, requested_by) VALUES ($1, $2, 'pending', $3) RETURNING id, key, name, status",
    [key, clean, userId]
  );
  return { brand: r, created: true };
}

// Approve / deny (admin, CEO). Deny needs a reason (the Requests card asks for one).
export async function decideBrand(id, user, approve, reason = "", db = pool) {
  if (!canApproveCompetitorBrands(user?.role)) throw new BrandError("Not allowed", 403);
  const why = String(reason ?? "").trim().slice(0, 500);
  if (!approve && !why) throw new BrandError("Write the reason");
  const { rows: [r] } = await db.query(
    `UPDATE competitor_brands SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4
     WHERE id = $1 AND status = 'pending' RETURNING id, key, name, status, requested_by`,
    [id, approve ? "approved" : "denied", user.id, approve ? null : why]
  );
  if (!r) throw new BrandError("This brand was already decided", 409);
  return r;
}
