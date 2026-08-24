import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { photoUpload, uploadDirPath } from "../upload.js";
import { haversineMeters } from "../utils/geo.js";
import { getCheckinRadiusMeters } from "../settings.js";
import { seesAllActivity } from "../roles.js";

export const checkinsRouter = Router();

checkinsRouter.use(requireAuth);

const VALID_BRANDS = new Set(["castrol", "lotos", "royal", "fake", "other_imports", "none"]);
const VALID_OUTCOMES = new Set([
  "order_placed",
  "no_order",
  "payment_collected",
  "follow_up_required",
  "customer_unavailable",
  "complaint",
  "stock_issue",
  "other",
]);

function parseBrandsFound(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const filtered = parsed.filter((b) => VALID_BRANDS.has(b));
  return filtered.length ? filtered : null;
}

checkinsRouter.post("/", (req, res, next) => {
  photoUpload.single("photo")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const { customer_id, lat, lng, note, brands_found, outcome } = req.body ?? {};
  const customerId = Number(customer_id);
  const latNum = Number(lat);
  const lngNum = Number(lng);

  if (!customerId || Number.isNaN(latNum) || Number.isNaN(lngNum)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "customer_id, lat and lng are required" });
  }

  const { rows: customerRows } = await pool.query(
    "SELECT id, lat, lng FROM customers WHERE id = $1",
    [customerId]
  );
  const customer = customerRows[0];
  if (!customer) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: "Customer not found" });
  }

  const radiusMeters = await getCheckinRadiusMeters();
  const distance = haversineMeters(latNum, lngNum, customer.lat, customer.lng);
  const withinRange = distance <= radiusMeters;
  const photoPath = req.file ? req.file.filename : null;
  const brands = parseBrandsFound(brands_found);
  const outcomeValue = VALID_OUTCOMES.has(outcome) ? outcome : null;

  let rows;
  try {
    ({ rows } = await pool.query(
      `INSERT INTO checkins (customer_id, user_id, lat, lng, distance_meters, within_range, note, photo_path, brands_found, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [customerId, req.user.id, latNum, lngNum, distance, withinRange, note ?? null, photoPath, brands, outcomeValue]
    ));
  } catch (err) {
    if (req.file) fs.unlink(req.file.path, () => {});
    throw err;
  }

  res.status(201).json(rows[0]);
});

function isValidDateString(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

checkinsRouter.get("/", async (req, res) => {
  const { range, customer_id, from, to } = req.query;
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

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT ch.*, u.name AS user_name, c.name AS customer_name
     FROM checkins ch
     JOIN users u ON u.id = ch.user_id
     JOIN customers c ON c.id = ch.customer_id
     ${where}
     ORDER BY ch.timestamp DESC`,
    params
  );
  res.json(rows);
});

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
