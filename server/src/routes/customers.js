import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

export const customersRouter = Router();

customersRouter.use(requireAuth);

const VISITED_THIS_WEEK_EXISTS = `EXISTS (
  SELECT 1 FROM checkins ch
  WHERE ch.customer_id = c.id AND ch.timestamp >= now() - interval '7 days'
)`;

customersRouter.get("/", async (req, res) => {
  const { search, visited } = req.query;
  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`c.name ILIKE $${params.length}`);
  }
  if (visited === "visited") {
    conditions.push(VISITED_THIS_WEEK_EXISTS);
  } else if (visited === "not_visited") {
    conditions.push(`NOT ${VISITED_THIS_WEEK_EXISTS}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT c.*, ${VISITED_THIS_WEEK_EXISTS} AS visited_this_week
     FROM customers c
     ${where}
     ORDER BY c.name`,
    params
  );
  res.json(rows);
});

customersRouter.post("/", async (req, res) => {
  const { name, category, phone, address, notes, lat, lng } = req.body ?? {};

  if (!name || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: "name, lat and lng are required" });
  }
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng must be numbers" });
  }

  const { rows } = await pool.query(
    `INSERT INTO customers (name, category, phone, address, notes, lat, lng, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [name, category ?? null, phone ?? null, address ?? null, notes ?? null, lat, lng, req.user.id]
  );
  res.status(201).json(rows[0]);
});

customersRouter.get("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, ${VISITED_THIS_WEEK_EXISTS} AS visited_this_week
     FROM customers c WHERE c.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Customer not found" });
  res.json(rows[0]);
});

const EDITABLE_FIELDS = ["name", "category", "phone", "address", "notes", "lat", "lng"];

customersRouter.patch("/:id", async (req, res) => {
  const updates = [];
  const params = [];

  for (const field of EDITABLE_FIELDS) {
    if (req.body?.[field] !== undefined) {
      params.push(req.body[field]);
      updates.push(`${field} = $${params.length}`);
    }
  }
  if (!updates.length) {
    return res.status(400).json({ error: "No editable fields provided" });
  }

  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE customers SET ${updates.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: "Customer not found" });
  res.json(rows[0]);
});

customersRouter.delete("/:id", requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM customers WHERE id = $1", [
    req.params.id,
  ]);
  if (!rowCount) return res.status(404).json({ error: "Customer not found" });
  res.status(204).end();
});

customersRouter.get("/:id/checkins", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ch.*, u.name AS user_name
     FROM checkins ch
     JOIN users u ON u.id = ch.user_id
     WHERE ch.customer_id = $1
     ORDER BY ch.timestamp DESC`,
    [req.params.id]
  );
  res.json(rows);
});
