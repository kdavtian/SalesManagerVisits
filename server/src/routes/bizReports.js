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

// Delivery speed (item 12 of the process review): how long confirmed orders take to be packed and
// delivered. Drivers do not use the app, so "delivered" is either marked by hand or set when the Excel
// sync finds the order (delivered_from_erp) -- the report splits the two, because an Excel match carries
// the lag of the sync.
const HOURS = (a, b) => `EXTRACT(EPOCH FROM (${b} - ${a})) / 3600`;
bizReportsRouter.get("/delivery-speed", async (req, res) => {
  if (!(await canAccessReport(req.user.role, "delivery_speed"))) return res.status(403).json({ error: "Not allowed" });
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const base = `
    SELECT o.id, o.order_code, o.status, o.delivered_from_erp, c.name AS customer_name,
      (SELECT min(x.changed_at) FROM order_status_history x WHERE x.order_id = o.id AND x.new_status = 'confirmed') AS confirmed_at,
      (SELECT max(x.changed_at) FROM order_status_history x WHERE x.order_id = o.id AND x.old_status = 'confirmed' AND x.new_status = 'packed_stock_out') AS packed_at,
      (SELECT max(x.changed_at) FROM order_status_history x WHERE x.order_id = o.id AND x.new_status = 'delivered') AS delivered_at
    FROM orders o JOIN customers c ON c.id = o.customer_id`;
  const { rows: done } = await pool.query(
    `WITH b AS (${base})
     SELECT id, order_code, customer_name, delivered_from_erp, confirmed_at, packed_at, delivered_at,
            ${HOURS("confirmed_at", "packed_at")}::float8 AS pack_hours,
            ${HOURS("packed_at", "delivered_at")}::float8 AS deliver_hours,
            ${HOURS("confirmed_at", "delivered_at")}::float8 AS total_hours
     FROM b WHERE status = 'delivered' AND confirmed_at IS NOT NULL AND delivered_at >= now() - ($1 || ' days')::interval
     ORDER BY delivered_at DESC LIMIT 2000`,
    [days]
  );
  const { rows: open } = await pool.query(
    `WITH b AS (${base})
     SELECT id, order_code, customer_name, status, confirmed_at, packed_at,
            ${HOURS("COALESCE(packed_at, confirmed_at)", "now()")}::float8 AS waiting_hours
     FROM b WHERE status IN ('confirmed', 'packed_stock_out') AND confirmed_at IS NOT NULL
     ORDER BY COALESCE(packed_at, confirmed_at) ASC LIMIT 15`
  );
  const nums = (key, only) => done.filter((r) => (only ? only(r) : true) && r[key] !== null && r[key] >= 0).map((r) => r[key]).sort((a, b) => a - b);
  const stat = (values) => ({
    n: values.length,
    avg: values.length ? Math.round((values.reduce((a, v) => a + v, 0) / values.length) * 10) / 10 : null,
    median: values.length ? Math.round(values[Math.floor(values.length / 2)] * 10) / 10 : null,
  });
  const totals = nums("total_hours");
  const within = (h) => (totals.length ? Math.round((totals.filter((v) => v <= h).length / totals.length) * 100) : null);
  res.json({
    days,
    delivered: done.length,
    pack: stat(nums("pack_hours")),
    deliver_by_hand: stat(nums("deliver_hours", (r) => !r.delivered_from_erp)),
    deliver_from_excel: stat(nums("deliver_hours", (r) => r.delivered_from_erp)),
    total: stat(totals),
    within_24h_pct: within(24),
    within_48h_pct: within(48),
    open,
    slowest: [...done].filter((r) => r.total_hours !== null).sort((a, b) => b.total_hours - a.total_hours).slice(0, 10).map((r) => ({ id: r.id, order_code: r.order_code, customer_name: r.customer_name, total_hours: Math.round(r.total_hours * 10) / 10, from_excel: r.delivered_from_erp })),
  });
});
