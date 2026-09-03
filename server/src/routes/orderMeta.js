import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { seesAllActivity } from "../roles.js";

export const orderMetaRouter = Router();

orderMetaRouter.use(requireAuth);

const PAGE_SIZE = 100;

function visibilityCondition(req, params, conditions) {
  if (seesAllActivity(req.user.role)) return;
  params.push(req.user.id);
  conditions.push(`o.user_id = $${params.length}`);
}

orderMetaRouter.get("/summary", async (req, res) => {
  const params = [];
  const conditions = [];
  visibilityCondition(req, params, conditions);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE o.status = 'submitted')::int AS submitted,
       COUNT(*) FILTER (WHERE o.status = 'confirmed')::int AS confirmed,
       COUNT(*) FILTER (WHERE o.status = 'packed')::int AS packed,
       COALESCE(
         json_agg(DISTINCT c.region ORDER BY c.region) FILTER (WHERE c.region IS NOT NULL AND btrim(c.region) <> ''),
         '[]'::json
       ) AS regions
     FROM orders o
     JOIN customers c ON c.id = o.customer_id
     ${where}`,
    params
  );

  const row = rows[0] || {};
  res.json({
    counts: {
      submitted: Number(row.submitted) || 0,
      confirmed: Number(row.confirmed) || 0,
      packed: Number(row.packed) || 0,
    },
    regions: Array.isArray(row.regions) ? row.regions : [],
  });
});

// Region-aware counterpart of GET /api/orders. It intentionally mirrors the
// existing list contract so the current Orders view can keep all of its
// rendering, pagination and detail behavior unchanged while adding one
// server-side dimension filter.
orderMetaRouter.get("/list", async (req, res) => {
  let { customer_id, user_id, status, offset, region } = req.query;
  const conditions = [];
  const params = [];

  if (!seesAllActivity(req.user.role)) {
    user_id = req.user.id;
  }
  if (customer_id) {
    params.push(customer_id);
    conditions.push(`o.customer_id = $${params.length}`);
  }
  if (user_id) {
    params.push(user_id);
    conditions.push(`o.user_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`o.status = $${params.length}`);
  }
  if (region) {
    params.push(region);
    conditions.push(`c.region = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const offsetNum = Math.max(0, Number(offset) || 0);
  params.push(PAGE_SIZE + 1, offsetNum);

  const { rows } = await pool.query(
    `SELECT o.*, u.name AS user_name, c.name AS customer_name, c.sales_channel, c.region
     FROM orders o
     JOIN users u ON u.id = o.user_id
     JOIN customers c ON c.id = o.customer_id
     ${where}
     ORDER BY o.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  res.json({ rows: rows.slice(0, PAGE_SIZE), has_more: rows.length > PAGE_SIZE });
});
