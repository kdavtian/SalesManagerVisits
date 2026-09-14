import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { seesAllPerformance } from "../roles.js";

export const salesPerformanceRouter = Router();

salesPerformanceRouter.use(requireAuth);

const SALES_DIRECTOR_REP_NAME = "Sales Director";

// A Sales Manager's rep_name is their `position` (e.g. "SM YVN") -- the
// same free-text field admins already set to match Castrol's per-channel
// naming (see roles overhaul: position suggestions drawn from the same
// workbook). Sales Directors all share the single "Sales Director" block;
// the sheet has no per-director breakdown to match against individually.
function repNameForUser(user) {
  if (user.role === "sales_director") return SALES_DIRECTOR_REP_NAME;
  if (user.role === "sales_manager" && user.position) return user.position;
  return null;
}

function summarize(rows) {
  const ytd = rows.reduce(
    (sum, r) => ({
      sales_amd: sum.sales_amd + Number(r.sales_amd),
      collected_amd: sum.collected_amd + Number(r.collected_amd),
      budget_amd: sum.budget_amd + Number(r.budget_amd),
    }),
    { sales_amd: 0, collected_amd: 0, budget_amd: 0 }
  );
  return ytd;
}

// The logged-in rep's own monthly series + YTD totals -- "my progress"
// for Sales Managers and Sales Directors specifically (per spec, this
// isn't a general team view; that's the /leaderboard-style endpoint below).
salesPerformanceRouter.get("/me", async (req, res) => {
  const repName = repNameForUser(req.user);
  if (!repName) {
    return res.status(403).json({ error: "Sales performance is only available to Sales Managers and Sales Directors" });
  }

  const { rows } = await pool.query(
    `SELECT month, sales_amd, collected_amd, budget_amd
     FROM sales_performance
     WHERE rep_name = $1 AND month >= date_trunc('year', now())
     ORDER BY month`,
    [repName]
  );

  if (!rows.length) {
    return res.json({ rep_name: repName, synced: false, monthly: [], ytd: null, current_month: null });
  }

  const currentMonth = rows.find(
    (r) => new Date(r.month).getUTCFullYear() === new Date().getUTCFullYear() && new Date(r.month).getUTCMonth() === new Date().getUTCMonth()
  );

  res.json({
    rep_name: repName,
    synced: true,
    monthly: rows,
    ytd: summarize(rows),
    current_month: currentMonth ?? null,
  });
});

// Compact ranking across every rep in the sheet -- for directors/CEO/
// admin to see the whole team at a glance (mirrors the points leaderboard's
// "who's ahead" framing, but for actual sales attainment). Sales/Collected
// are only ever tracked per calendar month (see sales_performance.month
// below), so this only supports the two periods that figure actually
// means something for -- "mtd" (this month) or "ytd" (every month so far
// this year, the default/only mode before the Company Dashboard's period
// filter was added). Today/WTD have no plan concept at this grain; the
// Company Dashboard instead reads those two from the daily-management
// report's day/wtd actuals (see reports.js), with no plan comparison.
//
// The "plan" figure compared against here used to be sales_performance's
// own budget_amd column (an Excel-synced field, separate from and never
// reconciled with Team Performance's own approved targets) -- that column
// turned out to carry stale/unreliable values (reported as Company
// Dashboard's Sales-vs-Plan bar reading e.g. "12,102,300 / 86,694 (100%)",
// a plan two orders of magnitude below actual sales). Team Performance
// already has a real, actively-maintained Sales plan per channel per
// month -- perf_plan_targets.sales_target_amd, entered through its own
// Planning workflow and gated on the plan being 'approved' -- so this now
// sums that instead, joined to sales_channels by code the same way
// teamPerformance.js's own loadChannelActuals matches a channel's actuals
// (rep_name = sales_channels.code). budget_amd itself is left as-is
// (still synced, just no longer read here) in case something else needs
// it later; nothing else in the app reads it.
salesPerformanceRouter.get("/", async (req, res) => {
  // Same company-wide visibility as the rest of Team Performance
  // (seesAllPerformance) -- Accountant reconciles these numbers day to
  // day just like Sales Director/CEO/admin, so it belongs here too (used
  // by the Company Dashboard quick action alongside those other roles).
  if (!seesAllPerformance(req.user.role)) {
    return res.status(403).json({ error: "Not allowed" });
  }

  const isMtd = req.query.period === "mtd";
  const spMonthCondition = isMtd ? "sp.month = date_trunc('month', now())" : "sp.month >= date_trunc('year', now())";
  const planMonthCondition = isMtd ? "pp.month = date_trunc('month', now())" : "pp.month >= date_trunc('year', now())";
  const { rows } = await pool.query(
    `SELECT sp.rep_name,
       sum(sp.sales_amd)::numeric AS sales_amd,
       sum(sp.collected_amd)::numeric AS collected_amd,
       COALESCE(plans.plan_amd, 0)::numeric AS plan_amd
     FROM sales_performance sp
     LEFT JOIN (
       SELECT sc.code, sum(pt.sales_target_amd) AS plan_amd
       FROM perf_plan_targets pt
       JOIN perf_plans pp ON pp.id = pt.plan_id AND pp.status = 'approved'
       JOIN sales_channels sc ON sc.id = pt.channel_id
       WHERE ${planMonthCondition}
       GROUP BY sc.code
     ) plans ON plans.code = sp.rep_name
     WHERE ${spMonthCondition} AND sp.rep_name != $1
     GROUP BY sp.rep_name, plans.plan_amd
     ORDER BY sum(sp.sales_amd) DESC`,
    [SALES_DIRECTOR_REP_NAME]
  );
  res.json(rows);
});
