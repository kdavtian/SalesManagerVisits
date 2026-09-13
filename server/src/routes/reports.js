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
  // "all" is the client's explicit All-time selection (see PERIOD_OPTIONS in
  // client/js/views/reports.js) -- no lower bound at all, not "this month".
  if (period === "all") return "'-infinity'::timestamptz";
  return "date_trunc('month', now())"; // default (period omitted, or "month"): this month
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

// Order fulfillment pipeline -- no per-transition audit trail exists for
// orders (unlike payments/cash handoffs, which log every status change to
// their own history table; see migrations/018 and 051: orders only ever
// carries created_at/updated_at). So "average time in status" per stage
// isn't honestly derivable after the fact -- what this can show instead:
// where this period's orders ended up, how long orders still sitting in
// an unfinished status have been there (updated_at only moves when status
// changes, so "now - updated_at" is really "time in current status"), and
// discount-approval turnaround for orders still waiting on one.
reportsRouter.get("/orders-pipeline", requireReportAccess("orders_pipeline"), async (req, res) => {
  const { period, manager_id } = req.query;
  const conditions = [`o.created_at >= ${periodBounds(period)}`];
  const params = [];
  if (manager_id) {
    params.push(manager_id);
    conditions.push(`o.user_id = $${params.length}`);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  const { rows: byStatus } = await pool.query(
    `SELECT o.status, count(*)::int AS count, COALESCE(sum(o.total_amd), 0) AS total_amd
     FROM orders o
     ${where}
     GROUP BY o.status
     ORDER BY count DESC`,
    params
  );

  const { rows: deliveredRows } = await pool.query(
    `SELECT count(*)::int AS delivered_count,
            AVG(EXTRACT(EPOCH FROM (o.updated_at - o.created_at)) / 3600) AS avg_cycle_hours
     FROM orders o
     ${where} AND o.status = 'delivered'`,
    params
  );

  // Deliberately not scoped to the period filter -- an order created two
  // months ago and still sitting in "confirmed" is exactly what this
  // should surface regardless of which period is selected, the same way
  // Payments' "oldest pending" ignores its own period filter for the same
  // reason.
  const stuckConditions = ["o.status IN ('draft', 'submitted', 'confirmed', 'packed_stock_out')"];
  const stuckParams = [];
  if (manager_id) {
    stuckParams.push(manager_id);
    stuckConditions.push(`o.user_id = $${stuckParams.length}`);
  }
  const stuckWhere = `WHERE ${stuckConditions.join(" AND ")}`;

  const { rows: activeByStatus } = await pool.query(
    `SELECT o.status, count(*)::int AS count,
            MIN(o.updated_at) AS oldest_updated_at,
            count(*) FILTER (WHERE o.updated_at < now() - interval '48 hours')::int AS stuck_over_48h
     FROM orders o
     ${stuckWhere}
     GROUP BY o.status
     ORDER BY count DESC`,
    stuckParams
  );

  const { rows: discountRows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE o.approval_status = 'pending')::int AS pending_count,
       min(o.updated_at) FILTER (WHERE o.approval_status = 'pending') AS oldest_pending_at,
       count(*) FILTER (WHERE o.approval_status = 'approved')::int AS approved_count,
       count(*) FILTER (WHERE o.approval_status = 'rejected')::int AS rejected_count
     FROM orders o
     ${where}`,
    params
  );

  res.json({
    by_status: byStatus,
    active: activeByStatus,
    delivered: deliveredRows[0],
    discount: discountRows[0],
  });
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

// Payments report -- reuses the canonical `payments` table directly (no
// separate reporting engine, per task spec), scoped to a period plus
// optional channel/manager/status. APPROVED is the only status that
// represents confirmed, reconciled collection; "submitted" (all statuses
// combined) is reported separately so the two are never conflated.
reportsRouter.get("/payments", requireReportAccess("payments"), async (req, res) => {
  const { period, sales_channel, sales_manager_id, status } = req.query;
  const conditions = [`p.payment_date >= ${periodBounds(period)}`];
  const params = [];
  if (sales_channel) {
    params.push(sales_channel);
    conditions.push(`p.sales_channel = $${params.length}`);
  }
  if (sales_manager_id) {
    params.push(sales_manager_id);
    conditions.push(`p.sales_manager_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`p.status = $${params.length}`);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  const { rows: kpiRows } = await pool.query(
    `SELECT
       count(*)::int AS submitted_count,
       COALESCE(sum(amount_amd), 0) AS submitted_amd,
       count(*) FILTER (WHERE status = 'approved')::int AS approved_count,
       COALESCE(sum(amount_amd) FILTER (WHERE status = 'approved'), 0) AS approved_amd,
       count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
       COALESCE(sum(amount_amd) FILTER (WHERE status = 'pending'), 0) AS pending_amd,
       count(*) FILTER (WHERE status = 'rejected')::int AS rejected_count,
       COALESCE(sum(amount_amd) FILTER (WHERE status = 'rejected'), 0) AS rejected_amd
     FROM payments p
     ${where}`,
    params
  );

  const { rows: byChannel } = await pool.query(
    `SELECT COALESCE(p.sales_channel, '—') AS sales_channel,
            count(*)::int AS submitted_count,
            COALESCE(sum(amount_amd) FILTER (WHERE status = 'approved'), 0) AS approved_amd
     FROM payments p
     ${where}
     GROUP BY p.sales_channel
     ORDER BY approved_amd DESC`,
    params
  );

  const { rows: byManager } = await pool.query(
    `SELECT p.sales_manager_id, p.sales_manager_name_snapshot AS sales_manager_name,
            count(*)::int AS submitted_count,
            COALESCE(sum(amount_amd) FILTER (WHERE status = 'approved'), 0) AS approved_amd
     FROM payments p
     ${where}
     GROUP BY p.sales_manager_id, p.sales_manager_name_snapshot
     ORDER BY approved_amd DESC`,
    params
  );

  // Daily approved-collections trend within the period -- keyed by the
  // day it was approved (not submitted), since that's the day the money
  // is actually confirmed as collected.
  const { rows: dailyTrend } = await pool.query(
    `SELECT date_trunc('day', approved_at)::date AS day, COALESCE(sum(amount_amd), 0) AS approved_amd
     FROM payments p
     ${where.replace("p.payment_date", "p.approved_at")} AND p.status = 'approved'
     GROUP BY day
     ORDER BY day`,
    params
  );

  const { rows: opsRows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
       min(created_at) FILTER (WHERE status = 'pending') AS oldest_pending_at,
       count(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '24 hours')::int AS pending_over_24h,
       count(*) FILTER (WHERE status = 'rejected')::int AS rejected_count,
       AVG(approved_at - created_at) FILTER (WHERE status = 'approved') AS avg_approval_interval
     FROM payments p
     ${where}`,
    params
  );

  res.json({
    kpis: kpiRows[0],
    by_channel: byChannel,
    by_manager: byManager,
    daily_trend: dailyTrend,
    operations: opsRows[0],
  });
});

// Real, physical cash the app already tracks custody of (see
// payments.js/cashHandoffs.js: current_holder_id + pending_handoff_id) but
// never rolled up into one view. Only 'pending' payments are unreconciled
// cash still travelling through the custody chain -- 'approved' means it
// already reached the accountant and was reconciled, 'rejected' means it
// was never real collected cash to begin with.
reportsRouter.get("/cash-custody", requireReportAccess("cash_custody"), async (req, res) => {
  const { rows: byHolder } = await pool.query(
    `SELECT p.current_holder_id, u.name AS holder_name, u.role AS holder_role,
            count(*)::int AS payment_count,
            COALESCE(sum(p.amount_amd), 0) AS amount_amd,
            count(*) FILTER (WHERE p.pending_handoff_id IS NOT NULL)::int AS in_transit_count
     FROM payments p
     JOIN users u ON u.id = p.current_holder_id
     WHERE p.status = 'pending'
     GROUP BY p.current_holder_id, u.name, u.role
     ORDER BY amount_amd DESC`
  );

  const { rows: totalsRows } = await pool.query(
    `SELECT COALESCE(sum(amount_amd), 0) AS total_unreconciled_amd,
            count(*)::int AS total_unreconciled_count,
            COALESCE(sum(amount_amd) FILTER (WHERE pending_handoff_id IS NOT NULL), 0) AS in_transit_amd,
            count(*) FILTER (WHERE pending_handoff_id IS NOT NULL)::int AS in_transit_count
     FROM payments
     WHERE status = 'pending'`
  );

  // In-flight handoffs -- declared by the sender, awaiting the receiver's
  // confirm/reject. "Overdue" mirrors the same 24h convention the Payments
  // report already uses for its own pending-approval ageing.
  const { rows: handoffs } = await pool.query(
    `SELECT h.id, h.amount_amd, h.submitted_at, fu.name AS from_name, tu.name AS to_name
     FROM cash_handoffs h
     JOIN users fu ON fu.id = h.from_user_id
     JOIN users tu ON tu.id = h.to_user_id
     WHERE h.status = 'pending'
     ORDER BY h.submitted_at ASC`
  );

  const { rows: opsRows } = await pool.query(
    `SELECT count(*)::int AS pending_handoff_count,
            min(submitted_at) AS oldest_pending_at,
            count(*) FILTER (WHERE submitted_at < now() - interval '24 hours')::int AS pending_over_24h
     FROM cash_handoffs
     WHERE status = 'pending'`
  );

  res.json({ by_holder: byHolder, totals: totalsRows[0], handoffs, operations: opsRows[0] });
});

// The next three read the Castrol ERP extract synced in by erpSync.js
// (erp_customer_data / sales_performance / perf_actuals_brand_monthly) --
// the same data an external Telegram bot on the sync PC already formats
// and sends outside this app, now also browsable here.

// How long an ERP sync can go stale before a report flags it rather than
// showing it as if it were current. Set above the "up to a few days between
// syncs is fine, the Excel extract still beats app data" tolerance the
// business actually runs on (see the comment on estimatedDebtJoin below) --
// this is a "the pipeline looks broken" flag, not a "the number is old" one.
const ERP_STALE_AFTER_HOURS = 72;

async function erpSyncFreshness(table) {
  const { rows } = await pool.query(`SELECT MAX(synced_at) AS synced_at FROM ${table}`);
  const syncedAt = rows[0]?.synced_at ?? null;
  const hoursSinceSync = syncedAt ? (Date.now() - new Date(syncedAt).getTime()) / 3.6e6 : null;
  return {
    synced_at: syncedAt,
    stale: hoursSinceSync == null || hoursSinceSync > ERP_STALE_AFTER_HOURS,
    stale_after_hours: ERP_STALE_AFTER_HOURS,
  };
}

// Debt/aging -- erp_customer_data is TRUNCATE-and-replaced whole on every
// sync (see erpSync.js), so this always reflects the latest extract, not
// an accumulating history. sales_channel here filters on
// assigned_sales_rep, the same free-text rep-name space sales_channels.code
// already matches for Team Performance.
//
// The Castrol Excel extract stays the trusted source of debt for as long as
// the app and ERP run in parallel (expected: months, not days) -- this
// never recomputes debt from app data wholesale, even though the app now
// tracks collections of its own. Instead, estimated_debt_amd narrows the
// gap between syncs the same way an individual customer's own card already
// does (see routes/customers.js GET /:id, "estimated_debt_amd"): subtract
// collections the app has recorded since the last sync, floored at zero.
// Both the raw ERP figure and the adjusted one are returned so a reviewer
// can see the gap, not just the result.
const estimatedDebtJoin = `
  LEFT JOIN LATERAL (
    SELECT SUM(ch.amount_collected_amd) AS amount
    FROM checkins ch
    JOIN customers c ON c.id = ch.customer_id
    WHERE c.erp_customer_id = erp.erp_customer_id
      AND ch.amount_collected_amd IS NOT NULL
      AND ch.timestamp > erp.synced_at
  ) collected ON true`;
const estimatedDebtExpr = "GREATEST(erp.debt_amd - COALESCE(collected.amount, 0), 0)";

reportsRouter.get("/customer-debt", requireReportAccess("customer_debt"), async (req, res) => {
  const { sales_channel, debt_only } = req.query;
  const conditions = [];
  const params = [];
  if (sales_channel) {
    params.push(sales_channel);
    conditions.push(`erp.assigned_sales_rep = $${params.length}`);
  }
  if (debt_only === "1") {
    conditions.push(`${estimatedDebtExpr} > 0`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows: customerRows } = await pool.query(
    `SELECT erp.erp_customer_id, erp.customer_name, erp.assigned_sales_rep, erp.debt_amd,
            erp.last_payment_date, erp.days_since_payment, erp.aging_bucket,
            COALESCE(collected.amount, 0) AS collected_since_sync_amd,
            ${estimatedDebtExpr} AS estimated_debt_amd
     FROM erp_customer_data erp
     ${estimatedDebtJoin}
     ${where}
     ORDER BY estimated_debt_amd DESC NULLS LAST`,
    params
  );

  const { rows: byBucket } = await pool.query(
    `SELECT COALESCE(erp.aging_bucket, '—') AS aging_bucket, count(*)::int AS customer_count,
            COALESCE(sum(${estimatedDebtExpr}), 0) AS total_debt_amd
     FROM erp_customer_data erp
     ${estimatedDebtJoin}
     ${where}
     GROUP BY erp.aging_bucket
     ORDER BY total_debt_amd DESC`,
    params
  );

  const { rows: totalsRows } = await pool.query(
    `SELECT COALESCE(sum(${estimatedDebtExpr}), 0) AS total_debt_amd,
            COALESCE(sum(erp.debt_amd), 0) AS total_debt_amd_erp,
            count(*) FILTER (WHERE ${estimatedDebtExpr} > 0)::int AS customers_with_debt
     FROM erp_customer_data erp
     ${estimatedDebtJoin}
     ${where}`,
    params
  );

  res.json({
    customers: customerRows,
    by_bucket: byBucket,
    totals: totalsRows[0],
    sync: await erpSyncFreshness("erp_customer_data"),
  });
});

// Sales vs. budget per rep/channel for one calendar month -- month comes in
// as "YYYY-MM" from an <input type="month">, normalized to that month's
// first day to match sales_performance's own month column (always a
// month-truncated date, see 015_sales_performance.sql).
reportsRouter.get("/sales-budget", requireReportAccess("sales_budget"), async (req, res) => {
  const { month } = req.query;
  const monthDate = /^\d{4}-\d{2}$/.test(month || "") ? `${month}-01` : null;

  const { rows } = await pool.query(
    `SELECT sp.rep_name, sc.name AS channel_name, sp.sales_amd, sp.budget_amd, sp.collected_amd
     FROM sales_performance sp
     LEFT JOIN sales_channels sc ON sc.code = sp.rep_name
     WHERE sp.month = date_trunc('month', COALESCE($1::date, now()))
     ORDER BY sp.sales_amd DESC`,
    [monthDate]
  );

  const totals = rows.reduce(
    (acc, r) => ({
      sales_amd: acc.sales_amd + Number(r.sales_amd),
      budget_amd: acc.budget_amd + Number(r.budget_amd),
      collected_amd: acc.collected_amd + Number(r.collected_amd),
    }),
    { sales_amd: 0, budget_amd: 0, collected_amd: 0 }
  );

  res.json({ rows, totals, sync: await erpSyncFreshness("sales_performance") });
});

// Brand volume (liters) per channel for one calendar month, plus a
// company-wide per-brand total for the same month.
reportsRouter.get("/brand-volume", requireReportAccess("brand_volume"), async (req, res) => {
  const { month, sales_channel } = req.query;
  const monthDate = /^\d{4}-\d{2}$/.test(month || "") ? `${month}-01` : null;
  const conditions = [`p.month = date_trunc('month', COALESCE($1::date, now()))`];
  const params = [monthDate];
  if (sales_channel) {
    params.push(sales_channel);
    conditions.push(`p.channel_code = $${params.length}`);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;

  const { rows } = await pool.query(
    `SELECT p.channel_code, sc.name AS channel_name, p.brand, p.liters
     FROM perf_actuals_brand_monthly p
     LEFT JOIN sales_channels sc ON sc.code = p.channel_code
     ${where}
     ORDER BY p.liters DESC`,
    params
  );

  const byBrandWhere = where.replace(/p\./g, "");
  const { rows: byBrand } = await pool.query(
    `SELECT brand, COALESCE(sum(liters), 0) AS total_liters
     FROM perf_actuals_brand_monthly
     ${byBrandWhere}
     GROUP BY brand
     ORDER BY total_liters DESC`,
    params
  );

  res.json({ rows, by_brand: byBrand, sync: await erpSyncFreshness("perf_actuals_brand_monthly") });
});

const REPORT_PERIODS = new Set(["daily", "weekly", "monthly", "quarterly", "annual"]);

// Daily management report -- a stored snapshot pushed once per
// (period, report_date) by POST /api/erp-sync/daily-report (see
// erpSync.js), not derived from the other ERP tables above. "Daily" is the
// default period (matches the name every existing caller already expects);
// ?period=weekly|monthly|quarterly|annual switches to that period's own
// latest-by-default/one-specific-date-via-?date= snapshot instead.
reportsRouter.get("/daily-management", requireReportAccess("daily_management"), async (req, res) => {
  const { date } = req.query;
  const period = REPORT_PERIODS.has(req.query.period) ? req.query.period : "daily";
  const { rows } = await pool.query(
    `SELECT *, report_date::text AS report_date, prev_report_date::text AS prev_report_date
     FROM erp_daily_report
     WHERE period = $2
       AND report_date = COALESCE($1::date, (SELECT max(report_date) FROM erp_daily_report WHERE period = $2))`,
    [/^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : null, period]
  );
  if (!rows.length) return res.json({ report: null, available_dates: [], period });

  const { rows: dates } = await pool.query(
    `SELECT report_date::text AS report_date FROM erp_daily_report WHERE period = $1 ORDER BY report_date DESC LIMIT 30`,
    [period]
  );
  res.json({ report: rows[0], available_dates: dates.map((d) => d.report_date), period });
});

// Generated report files (Sales Director workbook, debt/receivables Excel,
// CEO management workbook) pushed as-is by POST /api/erp-sync/reports (see
// erpSync.js) -- metadata only, not the file bytes themselves (see the
// /documents/:id/download route below for that).
reportsRouter.get("/documents", requireReportAccess("documents"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, report_type, report_date::text AS report_date, file_name, synced_at
     FROM generated_reports
     ORDER BY report_date DESC, report_type`
  );
  res.json(rows);
});

reportsRouter.get("/documents/:id/download", requireReportAccess("documents"), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT file_name, content_type, file_data FROM generated_reports WHERE id = $1",
    [req.params.id]
  );
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: "Report not found" });
  res.setHeader("Content-Type", doc.content_type);
  res.setHeader("Content-Disposition", `attachment; filename="${doc.file_name.replace(/"/g, "")}"`);
  res.send(doc.file_data);
});
