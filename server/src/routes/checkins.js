import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { photoUpload, uploadDirPath } from "../upload.js";
import { haversineMeters } from "../utils/geo.js";
import { getCheckinRadiusMeters } from "../settings.js";
import { seesAllActivity } from "../roles.js";
import { notifyTelegram, escapeHtml } from "../telegram.js";

// Below this, a payment isn't worth interrupting anyone's Telegram for.
const LARGE_PAYMENT_THRESHOLD_AMD = 100000;

export const checkinsRouter = Router();

checkinsRouter.use(requireAuth);

const VALID_OUTCOMES = new Set([
  "order_placed",
  "no_order",
  "payment_collected",
  "follow_up_required",
  "assortment_check",
  "customer_unavailable",
  "complaint",
  "other",
]);

const BRAND_STATUS_OPTIONS = {
  castrol: new Set([
    "available",
    "unavailable",
    "full_range",
    "fake",
    "imported_us",
    "imported_dubai",
    "imported_ru",
    "imported_other",
  ]),
  lotos: new Set(["available", "unavailable", "full_range"]),
  royal: new Set(["available", "unavailable", "full_range"]),
  competitors: new Set(["mobil", "motul", "shell", "liquimoly", "bardahl", "aral", "oscar", "zic", "russian_oil"]),
};

function parseOutcomes(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((o) => VALID_OUTCOMES.has(o));
}

// A free-text list (product names/brands from this customer's own order
// history, not a fixed catalog whitelist) -- just sanitized and capped,
// same trust level as `note`.
const MAX_AVAILABLE_PRODUCTS = 200;
function parseAvailableProducts(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const values = parsed
    .filter((v) => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, MAX_AVAILABLE_PRODUCTS);
  return values.length ? values : null;
}

function parseBrandStatus(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const result = {};
  for (const [brand, allowed] of Object.entries(BRAND_STATUS_OPTIONS)) {
    const values = Array.isArray(parsed[brand]) ? parsed[brand].filter((v) => allowed.has(v)) : [];
    if (!values.length) continue;
    // Defensive: "available" and "unavailable" are mutually exclusive; the
    // client already enforces this, but never trust the client alone.
    const deduped = values.includes("available") ? values.filter((v) => v !== "unavailable") : values;
    result[brand] = deduped;
  }
  return Object.keys(result).length ? result : null;
}

const MAX_PHOTOS_PER_CHECKIN = 5;

checkinsRouter.post("/", (req, res, next) => {
  photoUpload.array("photos", MAX_PHOTOS_PER_CHECKIN)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const { customer_id, lat, lng, note, brand_status, outcomes, amount_collected_amd, available_products } = req.body ?? {};
  const customerId = Number(customer_id);
  const latNum = Number(lat);
  const lngNum = Number(lng);
  const outcomeValues = parseOutcomes(outcomes);
  const files = req.files ?? [];

  if (!customerId || Number.isNaN(latNum) || Number.isNaN(lngNum) || !outcomeValues.length) {
    files.forEach((f) => fs.unlink(f.path, () => {}));
    return res.status(400).json({ error: "customer_id, lat, lng and at least one outcome are required" });
  }

  // Only meaningful (and required) when the rep actually flagged this visit
  // as a collection -- an amount on a visit with no such outcome would be
  // an orphaned, unexplainable number in the accountant's payment list.
  let amountCollected = null;
  if (outcomeValues.includes("payment_collected")) {
    amountCollected = Number(amount_collected_amd);
    if (!Number.isFinite(amountCollected) || amountCollected <= 0) {
      files.forEach((f) => fs.unlink(f.path, () => {}));
      return res.status(400).json({ error: "amount_collected_amd must be a positive number when payment_collected is selected" });
    }
  }

  const { rows: customerRows } = await pool.query(
    "SELECT id, name, lat, lng FROM customers WHERE id = $1",
    [customerId]
  );
  const customer = customerRows[0];
  if (!customer) {
    files.forEach((f) => fs.unlink(f.path, () => {}));
    return res.status(404).json({ error: "Customer not found" });
  }

  const radiusMeters = await getCheckinRadiusMeters();
  const distance = haversineMeters(latNum, lngNum, customer.lat, customer.lng);
  const withinRange = distance <= radiusMeters;
  const brandStatusValue = parseBrandStatus(brand_status);
  const availableProductsValue = parseAvailableProducts(available_products);

  const client = await pool.connect();
  let checkin;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, note, brand_status, outcomes, amount_collected_amd, available_products)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [customerId, req.user.id, latNum, lngNum, distance, withinRange, note ?? null, brandStatusValue, outcomeValues, amountCollected, availableProductsValue]
    );
    checkin = rows[0];
    for (const file of files) {
      await client.query("INSERT INTO checkin_photos (checkin_id, photo_path) VALUES ($1, $2)", [
        checkin.id,
        file.filename,
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    files.forEach((f) => fs.unlink(f.path, () => {}));
    throw err;
  } finally {
    client.release();
  }

  res.status(201).json({ ...checkin, photo_count: files.length });

  if (amountCollected != null && amountCollected >= LARGE_PAYMENT_THRESHOLD_AMD) {
    const { rows: repRows } = await pool.query("SELECT name FROM users WHERE id = $1", [req.user.id]);
    notifyTelegram(
      `💰 <b>Large payment collected</b>\n${escapeHtml(repRows[0]?.name || "Someone")} — ${escapeHtml(customer.name)}\n${Math.round(amountCollected).toLocaleString()} AMD`
    );
  }
});

function isValidDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

const CHECKINS_PAGE_SIZE = 200;

checkinsRouter.get("/", async (req, res) => {
  const { range, customer_id, from, to, payments_only, offset } = req.query;
  let { user_id } = req.query;

  // Plain managers only see their own check-ins; admins and every
  // director-tier role (sales/warehouse/delivery) can filter by any user.
  if (!seesAllActivity(req.user.role)) {
    user_id = req.user.id;
  }

  const conditions = [];
  const params = [];

  // An explicit custom range (from/to) takes priority over the range
  // keyword -- the two are alternative ways to express "since when", not
  // meant to be combined.
  if (isValidDateString(from)) {
    params.push(from);
    conditions.push(`ch.timestamp >= $${params.length}::date`);
  } else if (range === "today") {
    conditions.push(`ch.timestamp >= date_trunc('day', now())`);
  } else if (range === "week") {
    conditions.push(`ch.timestamp >= now() - interval '7 days'`);
  } else if (range === "month") {
    conditions.push(`ch.timestamp >= now() - interval '30 days'`);
  }
  if (isValidDateString(to)) {
    params.push(to);
    conditions.push(`ch.timestamp < ($${params.length}::date + interval '1 day')`);
  }
  if (user_id) {
    params.push(user_id);
    conditions.push(`ch.user_id = $${params.length}`);
  }
  if (customer_id) {
    params.push(customer_id);
    conditions.push(`ch.customer_id = $${params.length}`);
  }
  if (payments_only === "true") {
    conditions.push(`ch.amount_collected_amd IS NOT NULL`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const offsetNum = Math.max(0, Number(offset) || 0);

  // Fetch one extra row to know whether there's a next page, without a
  // separate COUNT(*) query -- trimmed back to CHECKINS_PAGE_SIZE before
  // sending.
  params.push(CHECKINS_PAGE_SIZE + 1, offsetNum);
  const { rows } = await pool.query(
    `SELECT ch.*, u.name AS user_name, c.name AS customer_name,
       COALESCE(
         (SELECT json_agg(json_build_object('id', cp.id) ORDER BY cp.id) FROM checkin_photos cp WHERE cp.checkin_id = ch.id),
         '[]'
       ) AS photos
     FROM checkins ch
     JOIN users u ON u.id = ch.user_id
     JOIN customers c ON c.id = ch.customer_id
     ${where}
     ORDER BY ch.timestamp DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  res.json({ rows: rows.slice(0, CHECKINS_PAGE_SIZE), has_more: rows.length > CHECKINS_PAGE_SIZE });
});

// Legacy single-photo endpoint -- still works for check-ins recorded before
// the multi-photo table existed (backfilled into checkin_photos, but this
// keeps old client caches / bookmarked URLs working).
checkinsRouter.get("/:id/photo", async (req, res) => {
  const { rows } = await pool.query("SELECT user_id, photo_path FROM checkins WHERE id = $1", [
    req.params.id,
  ]);
  const checkin = rows[0];
  if (!checkin || !checkin.photo_path) {
    return res.status(404).json({ error: "Photo not found" });
  }
  if (!seesAllActivity(req.user.role) && checkin.user_id !== req.user.id) {
    return res.status(403).json({ error: "Not allowed" });
  }

  res.sendFile(path.join(uploadDirPath, checkin.photo_path), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Photo not found" });
  });
});

checkinsRouter.delete("/:id/photo", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT photo_path FROM checkins WHERE id = $1", [
    req.params.id,
  ]);
  const checkin = rows[0];
  if (!checkin || !checkin.photo_path) {
    return res.status(404).json({ error: "Photo not found" });
  }

  fs.unlink(path.join(uploadDirPath, checkin.photo_path), () => {});
  await pool.query("UPDATE checkins SET photo_path = NULL WHERE id = $1", [req.params.id]);
  res.status(204).end();
});

checkinsRouter.get("/photos/:photoId", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cp.photo_path, ch.user_id
     FROM checkin_photos cp
     JOIN checkins ch ON ch.id = cp.checkin_id
     WHERE cp.id = $1`,
    [req.params.photoId]
  );
  const photo = rows[0];
  if (!photo) return res.status(404).json({ error: "Photo not found" });
  if (!seesAllActivity(req.user.role) && photo.user_id !== req.user.id) {
    return res.status(403).json({ error: "Not allowed" });
  }

  res.sendFile(path.join(uploadDirPath, photo.photo_path), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Photo not found" });
  });
});

checkinsRouter.delete("/photos/:photoId", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("DELETE FROM checkin_photos WHERE id = $1 RETURNING photo_path", [
    req.params.photoId,
  ]);
  const photo = rows[0];
  if (!photo) return res.status(404).json({ error: "Photo not found" });

  fs.unlink(path.join(uploadDirPath, photo.photo_path), () => {});
  res.status(204).end();
});
