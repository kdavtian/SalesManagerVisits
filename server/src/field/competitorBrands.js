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
// names that are words of the JavaScript language itself: as a key they would clash with every object (review, 2026-11-19)
const RESERVED = new Set(["constructor", "__proto__", "prototype", "tostring", "valueof", "hasownproperty", "isprototypeof", "propertyisenumerable", "tolocalestring", "__definegetter__", "__definesetter__", "__lookupgetter__", "__lookupsetter__"]);

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
  if (RESERVED.has(key.replace(/_/g, "")) || RESERVED.has(key)) throw new BrandError("This name cannot be used");
  // the same brand whatever the spacing: "Liqui Moly" = liquimoly
  const findSame = async () =>
    (await db.query("SELECT id, key, name, status, requested_by FROM competitor_brands WHERE replace(key, '_', '') = replace($1, '_', '') OR lower(name) = lower($2) ORDER BY status = 'approved' DESC, id LIMIT 1", [key, clean])).rows[0];
  const same = await findSame();
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
  // two reps adding it at the same moment: one row; the second gets the first one's brand
  const { rows: [r] } = await db.query(
    "INSERT INTO competitor_brands (key, name, status, requested_by) VALUES ($1, $2, 'pending', $3) ON CONFLICT (key) DO NOTHING RETURNING id, key, name, status",
    [key, clean, userId]
  );
  if (r) return { brand: r, created: true };
  const other = await findSame();
  return { brand: { id: other.id, key: other.key, name: other.name, status: other.status }, created: false };
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

// What a check-in may record: the brands (approved or waiting) and the product lines with their unit (L / kg).
export async function shelfCatalogue(db = pool) {
  const [keys, { rows: lines }] = await Promise.all([recordableKeys(db), db.query("SELECT code, unit FROM volume_potential_lines")]);
  return { brandKeys: keys, lineUnits: new Map(lines.map((l) => [l.code, l.unit])) };
}

// The prices a visit wrote: [{ brand, line, volume, wholesale, retail }] -> clean rows (unknown brand / line, bad numbers dropped;
// a row with neither price is dropped; at most 300).
export function cleanCompetitorPrices(raw, { brandKeys, lineUnits }) {
  let list;
  try {
    list = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const amd = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Math.round(Number(String(v).replace(/[\s,]/g, "")));
    return Number.isFinite(n) && n >= 0 && n <= 999999999 ? n : undefined; // the sheet's box takes 9 digits
  };
  const out = new Map();
  for (const r of list.slice(0, 300)) {
    if (!r || typeof r !== "object") continue;
    const brand = String(r.brand ?? "");
    const line = String(r.line ?? "");
    const volume = Math.round(Number(r.volume) * 1000) / 1000;
    if (!brandKeys.has(brand) || !lineUnits.has(line) || !(volume > 0 && volume <= 10000)) continue;
    const wholesale = amd(r.wholesale);
    const retail = amd(r.retail);
    if (wholesale === undefined || retail === undefined || (wholesale === null && retail === null)) continue;
    out.set(`${brand}|${line}|${volume}`, { brand, line, volume, unit: lineUnits.get(line), wholesale, retail });
  }
  return [...out.values()];
}

// The latest price recorded for each line and volume of a brand, by anyone (owner: everyone sees all prices).
// -> { [line_code]: { [volume]: { wholesale, retail, at, by } } }
export async function latestPrices(brandKey, db = pool) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (line_code, volume) line_code, volume::float8 AS volume, wholesale_amd, retail_amd, recorded_at, COALESCE(u.name_hy, u.name) AS by_name
     FROM competitor_prices p LEFT JOIN users u ON u.id = p.user_id
     WHERE brand_key = $1 ORDER BY line_code, volume, recorded_at DESC, p.id DESC`,
    [brandKey]
  );
  const out = {};
  for (const r of rows) (out[r.line_code] ??= {})[r.volume] = { wholesale: r.wholesale_amd, retail: r.retail_amd, at: r.recorded_at, by: r.by_name };
  return out;
}
