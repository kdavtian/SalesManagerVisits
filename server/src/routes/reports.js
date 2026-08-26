import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { ROLES } from "../roles.js";
import { REPORTS, findReport, canAccessReport } from "../reports.js";

export const reportsRouter = Router();

reportsRouter.use(requireAuth);

// List the reports the current user is allowed to see, for the Reports
// list page -- each entry just carries its key + i18n keys, the client
// looks up the actual name/description text.
reportsRouter.get("/", async (req, res) => {
  const visible = [];
  for (const report of REPORTS) {
    if (await canAccessReport(req.user.role, report.key)) {
      visible.push({ key: report.key, nameKey: report.nameKey, descriptionKey: report.descriptionKey });
    }
  }
  res.json(visible);
});

// Admin-only: full role x report override matrix, for the "Reports
// management" settings screen. Returns every REPORTS x ROLES pair with its
// effective (possibly default) enabled state, so the UI can render a
// checkbox grid without the admin needing to know the code defaults.
reportsRouter.get("/access", requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT report_key, role, enabled FROM report_access");
  const overrides = new Map(rows.map((r) => [`${r.report_key}:${r.role}`, r.enabled]));
  const matrix = REPORTS.map((report) => ({
    key: report.key,
    nameKey: report.nameKey,
    roles: ROLES.filter((role) => role !== "admin").map((role) => ({
      role,
      enabled: overrides.has(`${report.key}:${role}`)
        ? overrides.get(`${report.key}:${role}`)
        : report.defaultRoles.includes(role),
    })),
  }));
  res.json(matrix);
});

// Admin-only: set one explicit override. Written even if it happens to
// match the code default -- simpler than trying to detect and skip a
// no-op, and a future default change shouldn't silently flip an admin's
// deliberate choice.
reportsRouter.put("/access", requireAdmin, async (req, res) => {
  const { report_key, role, enabled } = req.body ?? {};
  if (!findReport(report_key)) return res.status(400).json({ error: "Unknown report_key" });
  if (!ROLES.includes(role) || role === "admin") return res.status(400).json({ error: "Invalid role" });
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be a boolean" });
  await pool.query(
    `INSERT INTO report_access (report_key, role, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (report_key, role) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [report_key, role, enabled]
  );
  res.status(204).end();
});

function requireReportAccess(reportKey) {
  return async (req, res, next) => {
    if (await canAccessReport(req.user.role, reportKey)) return next();
    res.status(403).json({ error: "Not allowed" });
  };
}

function periodBounds(period) {
  if (period === "today") return "date_trunc('day', now())";
  if (period === "week") return "date_trunc('week', now())";
  if (period === "year") return "date_trunc('year', now())";
  return "date_trunc('month', now())"; // default: this month
}

// Who created each new customer, when, and by which manager -- lets the
// office answer "who is actively finding new opportunities" directly,
// rather than inferring it from visit activity.
reportsRouter.get("/new-customers", requireReportAccess("new_customers"), async (req, res) => {
  const { region, subregion, manager_id, period, customer_tier } = req.query;
  const conditions = [`c.created_at >= ${periodBounds(period)}`];
  const params = [];
  if (region) {
    params.push(region);
    conditions.push(`c.region = $${params.length}`);
  }
  if (subregion) {
    params.push(subregion);
    conditions.push(`c.subregion = $${params.length}`);
  }
  if (manager_id) {
    params.push(manager_id);
    conditions.push(`c.created_by = $${params.length}`);
  }
  if (customer_tier) {
    params.push(customer_tier);
    conditions.push(`c.customer_tier = $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.category, c.customer_tier, c.region, c.subregion, c.created_at,
            u.id AS created_by_id, u.name AS created_by_name
     FROM customers c
     JOIN users u ON u.id = c.created_by
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.created_at DESC`,
    params
  );

  const { rows: byManager } = await pool.query(
    `SELECT u.id AS user_id, u.name AS user_name, count(c.id)::int AS new_customers
     FROM users u
     LEFT JOIN customers c ON c.created_by = u.id AND ${conditions.join(" AND ")}
     WHERE u.role = 'sales_manager'
     GROUP BY u.id, u.name
     ORDER BY new_customers DESC, u.name`,
    params
  );

  res.json({ customers: rows, by_manager: byManager });
});

// Check-ins filterable across every axis the field org cares about --
// region/subregion/manager/period/type(category)/tier/outcome. Outcome is
// matched against the `outcomes` array since a single visit can log more
// than one.
reportsRouter.get("/checkins", requireReportAccess("checkins"), async (req, res) => {
  const { region, subregion, manager_id, period, category, customer_tier, outcome } = req.query;
  const conditions = [];
  const params = [];
  if (period) {
    conditions.push(`ch.timestamp >= ${periodBounds(period)}`);
  }
  if (region) {
    params.push(region);
    conditions.push(`c.region = $${params.length}`);
  }
  if (subregion) {
    params.push(subregion);
    conditions.push(`c.subregion = $${params.length}`);
  }
  if (manager_id) {
    params.push(manager_id);
    conditions.push(`ch.user_id = $${params.length}`);
  }
  if (category) {
    params.push(category);
    conditions.push(`c.category = $${params.length}`);
  }
  if (customer_tier) {
    params.push(customer_tier);
    conditions.push(`c.customer_tier = $${params.length}`);
  }
  if (outcome) {
    params.push(outcome);
    conditions.push(`$${params.length} = ANY(ch.outcomes)`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `SELECT ch.id, ch.timestamp, ch.outcomes, ch.note,
            u.id AS user_id, u.name AS user_name,
            c.id AS customer_id, c.name AS customer_name, c.region, c.subregion, c.category, c.customer_tier
     FROM checkins ch
     JOIN users u ON u.id = ch.user_id
     JOIN customers c ON c.id = ch.customer_id
     ${where}
     ORDER BY ch.timestamp DESC
     LIMIT 500`,
    params
  );

  res.json({ checkins: rows, total: rows.length });
});

// Brand presence per customer, from the latest check-in that actually
// recorded a brand_status -- both our own brands and the named
// competitors, so the office can see e.g. how Mobil is distributed across
// Yerevan the same way they can see Castrol.
reportsRouter.get("/brand-availability", requireReportAccess("brand_availability"), async (req, res) => {
  const { region, subregion, manager_id } = req.query;
  const conditions = ["ch.brand_status IS NOT NULL"];
  const params = [];
  if (region) {
    params.push(region);
    conditions.push(`c.region = $${params.length}`);
  }
  if (subregion) {
    params.push(subregion);
    conditions.push(`c.subregion = $${params.length}`);
  }
  if (manager_id) {
    params.push(manager_id);
    conditions.push(`c.assigned_manager_id = $${params.length}`);
  }

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (c.id)
            c.id AS customer_id, c.name, c.region, c.subregion, c.lat, c.lng,
            ch.brand_status, ch.timestamp AS as_of
     FROM checkins ch
     JOIN customers c ON c.id = ch.customer_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.id, ch.timestamp DESC`,
    params
  );

  res.json(rows);
});
