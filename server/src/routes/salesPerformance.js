import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";

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

// Compact YTD ranking across every rep in the sheet -- for directors/CEO/
// admin to see the whole team at a glance (mirrors the points leaderboard's
// "who's ahead" framing, but for actual sales attainment).
salesPerformanceRouter.get("/", async (req, res) => {
  if (!["admin", "ceo", "sales_director"].includes(req.user.role)) {
    return res.status(403).json({ error: "Not allowed" });
  }

  const { rows } = await pool.query(
    `SELECT rep_name,
       sum(sales_amd)::numeric AS sales_amd,
       sum(collected_amd)::numeric AS collected_amd,
       sum(budget_amd)::numeric AS budget_amd
     FROM sales_performance
     WHERE month >= date_trunc('year', now()) AND rep_name != $1
     GROUP BY rep_name
     ORDER BY sum(sales_amd) DESC`,
    [SALES_DIRECTOR_REP_NAME]
  );
  res.json(rows);
});
