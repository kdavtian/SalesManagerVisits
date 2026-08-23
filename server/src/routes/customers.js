import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin, requireDirectEditAccess } from "../middleware/auth.js";
import { seesAllActivity } from "../roles.js";

export const customersRouter = Router();

customersRouter.use(requireAuth);

const LAST_VISIT_SUBQUERY = `(SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id)`;

// Derived visit status — no assignment/planning data exists yet, so
// "overdue" is approximated from each customer's own visit_frequency_days
// against their actual last check-in, not a fabricated schedule.
const STATUS_COLUMNS = `
  ${LAST_VISIT_SUBQUERY} AS last_visit_at,
  EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= date_trunc('day', now())) AS visited_today,
  EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= now() - interval '7 days') AS visited_this_week,
  (
    NOT EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= date_trunc('day', now()))
    AND (
      ${LAST_VISIT_SUBQUERY} IS NULL
      OR ${LAST_VISIT_SUBQUERY} < now() - (c.visit_frequency_days || ' days')::interval
    )
  ) AS overdue
`;

customersRouter.get("/", async (req, res) => {
  const { search, visited } = req.query;
  const conditions = [];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`c.name ILIKE $${params.length}`);
  }
  if (visited === "visited") {
    conditions.push(`EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= now() - interval '7 days')`);
  } else if (visited === "not_visited") {
    conditions.push(`NOT EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= now() - interval '7 days')`);
  } else if (visited === "overdue") {
    conditions.push(`(
      NOT EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ch.timestamp >= date_trunc('day', now()))
      AND (
        ${LAST_VISIT_SUBQUERY} IS NULL
        OR ${LAST_VISIT_SUBQUERY} < now() - (c.visit_frequency_days || ' days')::interval
      )
    )`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const { rows } = await pool.query(
    `SELECT c.*, ${STATUS_COLUMNS}
     FROM customers c
     ${where}
     ORDER BY c.name`,
    params
  );
  res.json(rows);
});

customersRouter.post("/", async (req, res) => {
  const { name, category, phone, address, notes, lat, lng, visit_frequency_days } = req.body ?? {};

  if (!name || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: "name, lat and lng are required" });
  }
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng must be numbers" });
  }

  const { rows } = await pool.query(
    `INSERT INTO customers (name, category, phone, address, notes, lat, lng, created_by, visit_frequency_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      name,
      category ?? null,
      phone ?? null,
      address ?? null,
      notes ?? null,
      lat,
      lng,
      req.user.id,
      Number(visit_frequency_days) || 14,
    ]
  );
  res.status(201).json(rows[0]);
});

customersRouter.get("/:id", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, ${STATUS_COLUMNS},
       erp.assigned_sales_rep AS erp_assigned_sales_rep,
       erp.debt_amd AS erp_debt_amd,
       erp.last_payment_date AS erp_last_payment_date,
       erp.days_since_payment AS erp_days_since_payment,
       erp.aging_bucket AS erp_aging_bucket,
       erp.recent_orders AS erp_recent_orders,
       erp.synced_at AS erp_synced_at
     FROM customers c
     LEFT JOIN erp_customer_data erp ON erp.erp_customer_id = c.erp_customer_id
     WHERE c.id = $1`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Customer not found" });
  res.json(rows[0]);
});

export const EDITABLE_FIELDS = ["name", "category", "phone", "address", "notes", "lat", "lng", "visit_frequency_days", "erp_customer_id"];

customersRouter.patch("/:id", requireDirectEditAccess, async (req, res) => {
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
  // Plain managers only see their own visit history on a customer, same
  // restriction as GET /api/checkins.
  const params = [req.params.id];
  let userFilter = "";
  if (!seesAllActivity(req.user.role)) {
    params.push(req.user.id);
    userFilter = `AND ch.user_id = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT ch.*, u.name AS user_name
     FROM checkins ch
     JOIN users u ON u.id = ch.user_id
     WHERE ch.customer_id = $1 ${userFilter}
     ORDER BY ch.timestamp DESC`,
    params
  );
  res.json(rows);
});
