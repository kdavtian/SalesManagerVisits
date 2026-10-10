// Two management reports: the weekly scorecard per rep (scorecard.js) and the new-customer
// pipeline (customers waiting for an Excel/ERP ID and how new customers convert).
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { canAccessReport } from "../reports.js";
import { buildScorecard } from "../scorecard.js";
import { yerevanToday } from "../utils/yerevanDate.js";

export const bizReportsRouter = Router();
bizReportsRouter.use(requireAuth);

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

bizReportsRouter.get("/scorecard", async (req, res) => {
  if (!(await canAccessReport(req.user.role, "weekly_scorecard"))) return res.status(403).json({ error: "Not allowed" });
  const week = isDate(req.query.week) ? req.query.week : yerevanToday();
  // A sales manager only ever sees their own row.
  const card = await buildScorecard(week, { userId: req.user.role === "sales_manager" ? req.user.id : null });
  res.json(card);
});

bizReportsRouter.get("/pipeline", async (req, res) => {
  if (!(await canAccessReport(req.user.role, "customer_pipeline"))) return res.status(403).json({ error: "Not allowed" });
  const { rows: waiting } = await pool.query(
    `SELECT c.id, c.name, c.region, c.created_at, (CURRENT_DATE - (c.created_at AT TIME ZONE 'Asia/Yerevan')::date)::int AS age_days,
            cu.name AS created_by_name, am.name AS manager_name,
            (SELECT count(*)::int FROM orders o WHERE o.customer_id = c.id AND o.status = 'draft') AS draft_orders,
            COALESCE((SELECT SUM(o.total_amd) FROM orders o WHERE o.customer_id = c.id AND o.status = 'draft'), 0)::float8 AS draft_amd
     FROM customers c
     LEFT JOIN users cu ON cu.id = c.created_by
     LEFT JOIN users am ON am.id = c.assigned_manager_id
     WHERE c.erp_customer_id IS NULL AND c.customer_tier <> 'competitor'
     ORDER BY c.created_at ASC LIMIT 300`
  );
  const { rows: funnel } = await pool.query(
    `SELECT count(*)::int AS created,
            count(*) FILTER (WHERE c.erp_customer_id IS NOT NULL)::int AS with_erp_id,
            count(*) FILTER (WHERE c.erp_customer_id IS NOT NULL AND (
              EXISTS (SELECT 1 FROM erp_order_lines l WHERE l.erp_customer_id = c.erp_customer_id)
              OR EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id AND o.status <> 'draft')))::int AS ordered
     FROM customers c WHERE c.created_at >= now() - interval '90 days' AND c.customer_tier <> 'competitor'`
  );
  res.json({ waiting, funnel: funnel[0] });
});
