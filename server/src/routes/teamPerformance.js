import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { isPerfCeo, canEditChannelPlan, canReviewPlan, canReviseApprovedPlan, seesAllPerformance, canCloseMonth } from "../roles.js";
import { notifyUser } from "../notifications.js";
import { PERF_APPROVER_ROLES } from "../notificationPreferences.js";
import { workingDaysForMonth } from "../workingDays.js";
import { kpiProgress } from "../perfCalc.js";
import { buildRecommendations, buildNeedsAttention } from "../perfRecommendations.js";

export const teamPerformanceRouter = Router();

teamPerformanceRouter.use(requireAuth);

function isValidMonth(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-01$/.test(value);
}

async function loadChannels() {
  const { rows } = await pool.query(
    "SELECT id, code, name, active, manager_user_id, owner_role, parent_channel_id, display_order FROM sales_channels ORDER BY display_order, code"
  );
  return rows;
}

// Every plan-detail response carries channels + targets + brand targets
// together -- the planning grid always needs all three at once, so this
// avoids a round trip per section.
async function loadPlanDetail(planId) {
  const { rows: planRows } = await pool.query("SELECT * FROM perf_plans WHERE id = $1", [planId]);
  const plan = planRows[0];
  if (!plan) return null;

  const [{ rows: targets }, { rows: brandTargets }, { rows: comments }] = await Promise.all([
    pool.query(
      `SELECT t.*, c.code AS channel_code, c.name AS channel_name, c.owner_role
       FROM perf_plan_targets t JOIN sales_channels c ON c.id = t.channel_id
       WHERE t.plan_id = $1 ORDER BY c.display_order`,
      [planId]
    ),
    pool.query(
      `SELECT bt.*, c.code AS channel_code
       FROM perf_plan_brand_targets bt JOIN sales_channels c ON c.id = bt.channel_id
       WHERE bt.plan_id = $1 ORDER BY c.display_order, bt.brand`,
      [planId]
    ),
    pool.query(
      `SELECT cm.*, u.name AS author_name
       FROM perf_plan_comments cm JOIN users u ON u.id = cm.author_id
       WHERE cm.plan_id = $1 ORDER BY cm.created_at`,
      [planId]
    ),
  ]);

  return { ...plan, targets, brand_targets: brandTargets, comments };
}

// Sales + Collections actuals reuse the existing sales_performance table
// (matched by channel code, same as before Team Performance existed) --
// Collections gets two numbers, not one: `confirmed` is what accounting
// has actually recorded in Excel (authoritative), `pending` is what's been
// logged in the app since that last Excel sync and hasn't reached
// accounting yet. Never blended into one total -- see the confirmed
// business rule this is built against.
async function loadChannelActuals(channelCode, monthStr) {
  const [{ rows: perfRows }, { rows: brandRows }, { rows: newCustRows }] = await Promise.all([
    pool.query("SELECT sales_amd, collected_amd, synced_at FROM sales_performance WHERE rep_name = $1 AND month = $2", [
      channelCode,
      monthStr,
    ]),
    pool.query("SELECT brand, liters FROM perf_actuals_brand_monthly WHERE channel_code = $1 AND month = $2", [
      channelCode,
      monthStr,
    ]),
    pool.query(
      `SELECT count(*)::int AS n FROM erp_customer_first_seen fs
       JOIN erp_customer_data d ON d.erp_customer_id = fs.erp_customer_id
       WHERE d.assigned_sales_rep = $1 AND fs.first_seen_month = $2`,
      [channelCode, monthStr]
    ),
  ]);

  const perf = perfRows[0] ?? { sales_amd: 0, collected_amd: 0, synced_at: null };
  const sinceTimestamp = perf.synced_at ?? `${monthStr}T00:00:00Z`;

  const { rows: pendingRows } = await pool.query(
    `SELECT COALESCE(sum(c.amount_collected_amd), 0) AS pending
     FROM checkins c JOIN users u ON u.id = c.user_id
     WHERE u.position = $1
       AND c.timestamp >= date_trunc('month', $2::date)
       AND c.timestamp < (date_trunc('month', $2::date) + interval '1 month')
       AND c.timestamp > $3
       AND c.amount_collected_amd IS NOT NULL`,
    [channelCode, monthStr, sinceTimestamp]
  );

  return {
    sales_actual: Number(perf.sales_amd),
    collected_confirmed: Number(perf.collected_amd),
    collected_pending: Number(pendingRows[0].pending),
    collected_synced_at: perf.synced_at,
    new_customers_actual: newCustRows[0].n,
    brand_actuals: brandRows,
  };
}

// Combines one channel's plan targets with its actuals into the shape
// every dashboard (management, Sales Director, personal) renders --
// achievement %, pace status, forecast, and required-daily-rate for every
// KPI, all from the single perfCalc.js engine.
function buildChannelDashboardRow(target, brandTargets, actuals, wd) {
  const kpiArgs = { elapsedWorkingDays: wd.elapsed, totalWorkingDays: wd.total, remainingWorkingDays: wd.remaining };

  const brandTargetsByBrand = new Map(brandTargets.map((bt) => [bt.brand, Number(bt.target_liters)]));
  const brandActualsByBrand = new Map(actuals.brand_actuals.map((ba) => [ba.brand, Number(ba.liters)]));
  const brands = new Set([...brandTargetsByBrand.keys(), ...brandActualsByBrand.keys()]);
  const brand_kpis = [...brands].map((brand) => ({
    brand,
    ...kpiProgress({ actual: brandActualsByBrand.get(brand) ?? 0, target: brandTargetsByBrand.get(brand) ?? 0, ...kpiArgs }),
  }));

  const row = {
    channel_id: target.channel_id,
    plan_id: target.plan_id,
    channel_code: target.channel_code,
    channel_name: target.channel_name,
    working_days: wd,
    sales: kpiProgress({ actual: actuals.sales_actual, target: Number(target.sales_target_amd), ...kpiArgs }),
    collections: {
      ...kpiProgress({ actual: actuals.collected_confirmed, target: Number(target.collection_target_amd), ...kpiArgs }),
      pending_amd: actuals.collected_pending,
      confirmed_synced_at: actuals.collected_synced_at,
    },
    new_customers: kpiProgress({ actual: actuals.new_customers_actual, target: target.new_customers_target, ...kpiArgs }),
    brands: brand_kpis,
  };
  row.recommendations = buildRecommendations(row);
  return row;
}

// Same shape as buildChannelDashboardRow, but from a frozen closed-month
// snapshot row instead of live targets+actuals -- a closed month is always
// fully elapsed (wd.elapsed === wd.total), so forecast is moot and
// required_daily_rate/status just report the final outcome.
function buildClosedChannelRow(snapshot, wd) {
  const kpiArgs = { elapsedWorkingDays: wd.elapsed, totalWorkingDays: wd.total, remainingWorkingDays: wd.remaining };
  const brand_kpis = (snapshot.brand_actuals ?? []).map((ba) => ({
    brand: ba.brand,
    ...kpiProgress({ actual: Number(ba.liters), target: Number(ba.target_liters ?? 0), ...kpiArgs }),
  }));

  const row = {
    channel_id: snapshot.channel_id,
    plan_id: snapshot.plan_id,
    channel_code: snapshot.channel_code,
    channel_name: snapshot.channel_name,
    working_days: wd,
    closed: true,
    sales: kpiProgress({ actual: Number(snapshot.sales_actual_amd), target: Number(snapshot.sales_target_amd), ...kpiArgs }),
    collections: {
      ...kpiProgress({ actual: Number(snapshot.collection_actual_amd), target: Number(snapshot.collection_target_amd), ...kpiArgs }),
      pending_amd: 0,
      confirmed_synced_at: null,
    },
    new_customers: kpiProgress({ actual: snapshot.new_customers_actual, target: snapshot.new_customers_target, ...kpiArgs }),
    brands: brand_kpis,
  };
  row.recommendations = [];
  return row;
}

async function writeAudit(client, planId, actorId, action, before, after, reason) {
  await client.query(
    `INSERT INTO perf_plan_audit (plan_id, actor_id, action, before, after, reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [planId, actorId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason ?? null]
  );
}

teamPerformanceRouter.get("/channels", async (req, res) => {
  res.json(await loadChannels());
});

// A Sales Manager's channel is their `position` field (same convention
// salesPerformance.js already uses); a Sales Director has no single
// channel of their own here -- they see every channel they own via the
// full plan endpoints above, gated by canEditChannelPlan.
function channelCodeForUser(user) {
  return user.role === "sales_manager" && user.position ? user.position : null;
}

// The one channel's approved plan for a month, combined with its actuals
// and pacing -- a Sales Manager's own "My Performance" view. Never exposes
// any other channel's numbers (see seesAllPerformance for who gets the
// full cross-channel picture instead).
teamPerformanceRouter.get("/my-performance", async (req, res) => {
  const { month } = req.query;
  if (!isValidMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM-01" });

  if (seesAllPerformance(req.user.role)) {
    return res.status(400).json({ error: "Use /plans/:id/dashboard for a full cross-channel view" });
  }
  const channelCode = channelCodeForUser(req.user);
  if (!channelCode) {
    return res.status(403).json({ error: "Team Performance is only available to Sales Managers with an assigned channel" });
  }

  const { rows } = await pool.query(
    `SELECT t.channel_id, p.id AS plan_id, c.code AS channel_code, c.name AS channel_name,
       t.sales_target_amd, t.collection_target_amd, t.new_customers_target
     FROM perf_plan_targets t
     JOIN perf_plans p ON p.id = t.plan_id
     JOIN sales_channels c ON c.id = t.channel_id
     WHERE c.code = $1 AND p.month = $2 AND p.status = 'approved'`,
    [channelCode, month]
  );
  const target = rows[0];
  if (!target) return res.json(null);

  const { rows: brandTargets } = await pool.query(
    `SELECT bt.brand, bt.target_liters FROM perf_plan_brand_targets bt
     JOIN perf_plans p ON p.id = bt.plan_id
     WHERE bt.channel_id = $1 AND p.month = $2 AND p.status = 'approved'`,
    [target.channel_id, month]
  );

  const monthDate = new Date(`${month}T00:00:00Z`);
  const [actuals, wd] = await Promise.all([loadChannelActuals(channelCode, month), workingDaysForMonth(monthDate)]);
  res.json(buildChannelDashboardRow(target, brandTargets, actuals, wd));
});

// The full cross-channel dashboard for one plan -- Management/Sales
// Director view. Restricted to roles that see company-wide data at all
// (seesAllPerformance); a Sales Director still only sees this for
// channels/plans they have some standing in via the same role check used
// everywhere else in this file, not a per-channel filter, since the whole
// point of this screen is comparing channels side by side.
teamPerformanceRouter.get("/plans/:id/dashboard", async (req, res) => {
  if (!seesAllPerformance(req.user.role)) return res.status(403).json({ error: "Not allowed" });

  const detail = await loadPlanDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "Plan not found" });

  const monthStr = detail.month.toISOString().slice(0, 10);
  const monthDate = new Date(`${monthStr}T00:00:00Z`);
  const wd = await workingDaysForMonth(monthDate);

  let rows;
  if (detail.status === "closed") {
    // A closed month reads from its frozen snapshot, never from live
    // actuals -- see migration 040. This is what makes "closed" mean
    // something: the numbers on this screen can't drift after the fact.
    const { rows: snapshot } = await pool.query(
      "SELECT * FROM perf_plan_closed_snapshot WHERE plan_id = $1 ORDER BY channel_name",
      [detail.id]
    );
    rows = snapshot.map((s) => buildClosedChannelRow(s, wd));
  } else {
    const brandTargetsByChannel = new Map();
    for (const bt of detail.brand_targets) {
      if (!brandTargetsByChannel.has(bt.channel_id)) brandTargetsByChannel.set(bt.channel_id, []);
      brandTargetsByChannel.get(bt.channel_id).push(bt);
    }

    rows = await Promise.all(
      detail.targets.map(async (target) => {
        const actuals = await loadChannelActuals(target.channel_code, monthStr);
        return buildChannelDashboardRow(target, brandTargetsByChannel.get(target.channel_id) ?? [], actuals, wd);
      })
    );
  }

  res.json({
    plan_id: detail.id,
    month: detail.month,
    status: detail.status,
    working_days: wd,
    channels: rows,
    needs_attention: buildNeedsAttention(rows),
  });
});

// Drill-down behind the two KPIs Field Visits actually has transaction-
// level data for. Sales Amount and confirmed Collections come only from
// the Excel-authoritative sales_performance aggregate -- there is no
// per-transaction record of those in this database to drill into (Excel is
// the system of record; see the erpSync business rule this module is built
// against). New customers and pending (not-yet-confirmed) collections,
// though, are things Field Visits itself tracks, so those get a real list.
teamPerformanceRouter.get("/plans/:id/channels/:channelId/drilldown", async (req, res) => {
  if (!seesAllPerformance(req.user.role) && req.user.role !== "sales_manager") {
    return res.status(403).json({ error: "Not allowed" });
  }
  const { kpi } = req.query;
  if (!["new_customers", "collections_pending"].includes(kpi)) {
    return res.status(400).json({ error: "kpi must be new_customers or collections_pending (the only drill-downs Field Visits has transaction-level data for)" });
  }

  const { rows: planRows } = await pool.query("SELECT month FROM perf_plans WHERE id = $1", [req.params.id]);
  if (!planRows[0]) return res.status(404).json({ error: "Plan not found" });
  const monthStr = planRows[0].month.toISOString().slice(0, 10);

  const { rows: channelRows } = await pool.query("SELECT code FROM sales_channels WHERE id = $1", [req.params.channelId]);
  const channel = channelRows[0];
  if (!channel) return res.status(404).json({ error: "Channel not found" });

  if (req.user.role === "sales_manager" && req.user.position !== channel.code) {
    return res.status(403).json({ error: "Not allowed to view another channel's data" });
  }

  if (kpi === "new_customers") {
    const { rows } = await pool.query(
      `SELECT d.erp_customer_id, d.customer_name, fs.first_seen_month
       FROM erp_customer_first_seen fs
       JOIN erp_customer_data d ON d.erp_customer_id = fs.erp_customer_id
       WHERE d.assigned_sales_rep = $1 AND fs.first_seen_month = $2
       ORDER BY d.customer_name`,
      [channel.code, monthStr]
    );
    return res.json(rows);
  }

  const { rows: perfRows } = await pool.query("SELECT synced_at FROM sales_performance WHERE rep_name = $1 AND month = $2", [
    channel.code,
    monthStr,
  ]);
  const sinceTimestamp = perfRows[0]?.synced_at ?? `${monthStr}T00:00:00Z`;
  const { rows } = await pool.query(
    `SELECT c.id AS checkin_id, c.timestamp, c.amount_collected_amd, cu.name AS customer_name, u.name AS logged_by
     FROM checkins c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN customers cu ON cu.id = c.customer_id
     WHERE u.position = $1
       AND c.timestamp >= date_trunc('month', $2::date)
       AND c.timestamp < (date_trunc('month', $2::date) + interval '1 month')
       AND c.timestamp > $3
       AND c.amount_collected_amd IS NOT NULL
     ORDER BY c.timestamp DESC`,
    [channel.code, monthStr, sinceTimestamp]
  );
  res.json(rows);
});

// The single "live" plan for a month -- draft/pending/approved/rejected,
// never a superseded or closed one (see the partial unique index in
// migration 038: at most one row can hold that state per month at a time).
teamPerformanceRouter.get("/plans", async (req, res) => {
  const { month } = req.query;
  if (!isValidMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM-01" });

  const { rows } = await pool.query(
    `SELECT id FROM perf_plans WHERE month = $1 AND status IN ('draft', 'pending_approval', 'approved', 'rejected')`,
    [month]
  );
  if (!rows.length) return res.json(null);
  res.json(await loadPlanDetail(rows[0].id));
});

teamPerformanceRouter.get("/plans/:id", async (req, res) => {
  const detail = await loadPlanDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "Plan not found" });
  res.json(detail);
});

// Every approved revision's full lineage, oldest first -- what the
// Approval Review / History screens diff against.
teamPerformanceRouter.get("/plans/:id/history", async (req, res) => {
  const { rows } = await pool.query(
    `WITH RECURSIVE chain AS (
       SELECT * FROM perf_plans WHERE id = $1
       UNION ALL
       SELECT p.* FROM perf_plans p JOIN chain ON p.id = chain.supersedes_plan_id
     )
     SELECT id, month, version, status, created_at, approved_at, revision_reason FROM chain ORDER BY version`,
    [req.params.id]
  );
  res.json(rows);
});

teamPerformanceRouter.get("/plans/:id/audit", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, u.name AS actor_name
     FROM perf_plan_audit a JOIN users u ON u.id = a.actor_id
     WHERE a.plan_id = $1 ORDER BY a.created_at`,
    [req.params.id]
  );
  res.json(rows);
});

// Creates a fresh DRAFT for a month. Optionally seeded from another
// month's targets ("copy previous month" / "same month last year" /
// "use previous actual" -- source_month picks the plan to copy targets
// from; the caller decides which month that is). Never auto-submits.
teamPerformanceRouter.post("/plans", async (req, res) => {
  const { month, source_month } = req.body ?? {};
  if (!isValidMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM-01" });
  if (!isPerfCeo(req.user.role) && req.user.role !== "sales_director" && req.user.role !== "accountant") {
    return res.status(403).json({ error: "Not allowed to create a plan" });
  }

  const { rows: existing } = await pool.query(
    `SELECT id FROM perf_plans WHERE month = $1 AND status IN ('draft', 'pending_approval', 'approved', 'rejected')`,
    [month]
  );
  if (existing.length) return res.status(409).json({ error: "A plan already exists for this month" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: created } = await client.query(
      `INSERT INTO perf_plans (month, version, status, created_by) VALUES ($1, 1, 'draft', $2) RETURNING *`,
      [month, req.user.id]
    );
    const plan = created[0];

    if (isValidMonth(source_month)) {
      const { rows: sourcePlan } = await client.query(
        `SELECT id FROM perf_plans WHERE month = $1 AND status IN ('approved', 'closed') ORDER BY version DESC LIMIT 1`,
        [source_month]
      );
      if (sourcePlan.length) {
        await client.query(
          `INSERT INTO perf_plan_targets (plan_id, channel_id, sales_target_amd, collection_target_amd, new_customers_target)
           SELECT $1, channel_id, sales_target_amd, collection_target_amd, new_customers_target
           FROM perf_plan_targets WHERE plan_id = $2`,
          [plan.id, sourcePlan[0].id]
        );
        await client.query(
          `INSERT INTO perf_plan_brand_targets (plan_id, channel_id, brand, target_liters)
           SELECT $1, channel_id, brand, target_liters
           FROM perf_plan_brand_targets WHERE plan_id = $2`,
          [plan.id, sourcePlan[0].id]
        );
      }
    }

    await writeAudit(client, plan.id, req.user.id, "create", null, { month, source_month: source_month ?? null });
    await client.query("COMMIT");
    res.status(201).json(await loadPlanDetail(plan.id));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// Upserts one channel's targets on a draft. One channel at a time (not a
// whole-plan bulk save) so the planning grid can autosave per cell/row
// without a lost-update risk on unrelated channels; lock_version still
// guards concurrent edits to the *same* channel row.
teamPerformanceRouter.put("/plans/:id/targets/:channelId", async (req, res) => {
  const { rows: planRows } = await pool.query("SELECT * FROM perf_plans WHERE id = $1", [req.params.id]);
  const plan = planRows[0];
  if (!plan) return res.status(404).json({ error: "Plan not found" });
  if (plan.status !== "draft") return res.status(409).json({ error: "Only a draft plan can be edited" });

  const { rows: channelRows } = await pool.query("SELECT * FROM sales_channels WHERE id = $1", [req.params.channelId]);
  const channel = channelRows[0];
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  if (!canEditChannelPlan(req.user.role, channel.owner_role)) {
    return res.status(403).json({ error: "Not allowed to edit this channel's plan" });
  }

  const { sales_target_amd, collection_target_amd, new_customers_target, brand_targets, expected_lock_version } = req.body ?? {};
  if (![sales_target_amd, collection_target_amd].every((v) => v === undefined || (Number.isFinite(v) && v >= 0))) {
    return res.status(400).json({ error: "Targets must be non-negative numbers" });
  }
  if (new_customers_target !== undefined && (!Number.isInteger(new_customers_target) || new_customers_target < 0)) {
    return res.status(400).json({ error: "new_customers_target must be a non-negative integer" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (expected_lock_version !== undefined) {
      const { rows: lockCheck } = await client.query(
        "SELECT lock_version FROM perf_plans WHERE id = $1 FOR UPDATE",
        [plan.id]
      );
      if (lockCheck[0].lock_version !== expected_lock_version) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This plan was modified by another user. Reload and try again." });
      }
    }

    const { rows: beforeRows } = await client.query(
      "SELECT * FROM perf_plan_targets WHERE plan_id = $1 AND channel_id = $2",
      [plan.id, channel.id]
    );

    const { rows: afterRows } = await client.query(
      `INSERT INTO perf_plan_targets (plan_id, channel_id, sales_target_amd, collection_target_amd, new_customers_target)
       VALUES ($1, $2, COALESCE($3, 0), COALESCE($4, 0), COALESCE($5, 0))
       ON CONFLICT (plan_id, channel_id) DO UPDATE SET
         sales_target_amd = COALESCE($3, perf_plan_targets.sales_target_amd),
         collection_target_amd = COALESCE($4, perf_plan_targets.collection_target_amd),
         new_customers_target = COALESCE($5, perf_plan_targets.new_customers_target)
       RETURNING *`,
      [plan.id, channel.id, sales_target_amd, collection_target_amd, new_customers_target]
    );

    if (Array.isArray(brand_targets)) {
      for (const bt of brand_targets) {
        if (!bt?.brand || !Number.isFinite(bt.target_liters) || bt.target_liters < 0) continue;
        await client.query(
          `INSERT INTO perf_plan_brand_targets (plan_id, channel_id, brand, target_liters)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (plan_id, channel_id, brand) DO UPDATE SET target_liters = $4`,
          [plan.id, channel.id, String(bt.brand), bt.target_liters]
        );
      }
    }

    await client.query("UPDATE perf_plans SET lock_version = lock_version + 1, updated_at = now() WHERE id = $1", [plan.id]);
    await writeAudit(client, plan.id, req.user.id, "edit_target", beforeRows[0] ?? null, afterRows[0]);

    await client.query("COMMIT");
    res.json(await loadPlanDetail(plan.id));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

teamPerformanceRouter.post("/plans/:id/comments", async (req, res) => {
  const { body, channel_id } = req.body ?? {};
  if (!body || typeof body !== "string" || !body.trim()) {
    return res.status(400).json({ error: "body is required" });
  }
  const { rows } = await pool.query(
    `INSERT INTO perf_plan_comments (plan_id, channel_id, author_id, body) VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [req.params.id, channel_id ?? null, req.user.id, body.trim()]
  );
  res.status(201).json(rows[0]);
});

teamPerformanceRouter.post("/plans/:id/submit", async (req, res) => {
  const { rows: planRows } = await pool.query("SELECT * FROM perf_plans WHERE id = $1", [req.params.id]);
  const plan = planRows[0];
  if (!plan) return res.status(404).json({ error: "Plan not found" });
  if (plan.status !== "draft") return res.status(409).json({ error: "Only a draft plan can be submitted" });
  if (!isPerfCeo(req.user.role) && req.user.role !== "sales_director" && req.user.role !== "accountant") {
    return res.status(403).json({ error: "Not allowed to submit this plan" });
  }

  const { rows: targetCount } = await pool.query("SELECT count(*)::int AS n FROM perf_plan_targets WHERE plan_id = $1", [plan.id]);
  if (!targetCount[0].n) {
    return res.status(400).json({ error: "Add at least one channel's targets before submitting" });
  }

  const { rows: updated } = await pool.query(
    `UPDATE perf_plans SET status = 'pending_approval', submitted_by = $1, submitted_at = now(), lock_version = lock_version + 1, updated_at = now()
     WHERE id = $2 RETURNING *`,
    [req.user.id, plan.id]
  );
  await writeAudit(pool, plan.id, req.user.id, "submit", { status: plan.status }, { status: "pending_approval" });
  res.json(updated[0]);

  (async () => {
    try {
      const roles = req.user.role === "sales_director" ? ["admin", "ceo", "accountant"] : ["admin", "ceo"];
      const { rows: reviewers } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [roles]);
      for (const reviewer of reviewers) {
        notifyUser(reviewer.id, "perf_plan_submitted", {
          title: "Performance plan needs review",
          body: `A plan for ${plan.month.toISOString?.() ?? plan.month} was submitted for approval.`,
          url: "/#/team-performance/approvals",
        });
      }
    } catch (err) {
      console.error("Post-perf-plan-submit notification failed:", err);
    }
  })();
});

teamPerformanceRouter.post("/plans/:id/approve", async (req, res) => {
  await reviewPlan(req, res, "approved");
});

teamPerformanceRouter.post("/plans/:id/reject", async (req, res) => {
  const { reason } = req.body ?? {};
  if (!reason || typeof reason !== "string" || !reason.trim()) {
    return res.status(400).json({ error: "A rejection reason is required" });
  }
  await reviewPlan(req, res, "rejected", reason.trim());
});

async function reviewPlan(req, res, nextStatus, reason) {
  const { rows: planRows } = await pool.query(
    "SELECT p.*, u.role AS submitted_by_role FROM perf_plans p LEFT JOIN users u ON u.id = p.submitted_by WHERE p.id = $1",
    [req.params.id]
  );
  const plan = planRows[0];
  if (!plan) return res.status(404).json({ error: "Plan not found" });
  if (plan.status !== "pending_approval") return res.status(409).json({ error: "Only a plan pending approval can be reviewed" });
  if (!canReviewPlan(req.user.role, plan.submitted_by_role)) {
    return res.status(403).json({ error: "Not allowed to review this plan" });
  }

  const { rows: updated } = await pool.query(
    `UPDATE perf_plans SET status = $1, approved_by = $2, approved_at = now(),
       rejected_reason = $3, lock_version = lock_version + 1, updated_at = now()
     WHERE id = $4 RETURNING *`,
    [nextStatus, req.user.id, nextStatus === "rejected" ? reason : null, plan.id]
  );
  await writeAudit(pool, plan.id, req.user.id, nextStatus, { status: "pending_approval" }, { status: nextStatus }, reason);
  res.json(updated[0]);

  (async () => {
    try {
      if (plan.submitted_by) {
        notifyUser(plan.submitted_by, "perf_plan_reviewed", {
          title: nextStatus === "approved" ? "Performance plan approved" : "Performance plan rejected",
          body:
            nextStatus === "approved"
              ? `Your plan was approved.`
              : `Your plan was rejected: ${reason}`,
          url: "/#/team-performance/planning",
        });
      }
    } catch (err) {
      console.error("Post-perf-plan-review notification failed:", err);
    }
  })();
}

// CEO-only: revises an already-approved plan. Never edits the approved row
// -- inserts version+1 as the new approved plan and marks the old one
// superseded, so every past version stays queryable forever (see
// perf_plans.supersedes_plan_id and GET /plans/:id/history above).
teamPerformanceRouter.post("/plans/:id/revise", async (req, res) => {
  if (!canReviseApprovedPlan(req.user.role)) {
    return res.status(403).json({ error: "Only the CEO can revise an approved plan" });
  }
  const { reason, targets } = req.body ?? {};
  if (!reason || typeof reason !== "string" || !reason.trim()) {
    return res.status(400).json({ error: "A reason is required to revise an approved plan" });
  }
  if (!Array.isArray(targets) || !targets.length) {
    return res.status(400).json({ error: "targets must be a non-empty array of { channel_id, ...fields to change }" });
  }

  const { rows: planRows } = await pool.query("SELECT * FROM perf_plans WHERE id = $1", [req.params.id]);
  const plan = planRows[0];
  if (!plan) return res.status(404).json({ error: "Plan not found" });
  if (plan.status !== "approved") return res.status(409).json({ error: "Only an approved plan can be revised" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Demote the old row first: the partial unique index only allows one
    // 'approved' plan per month, and it's not deferrable, so inserting the
    // new revision before this would collide with the row it's replacing.
    await client.query("UPDATE perf_plans SET status = 'superseded', updated_at = now() WHERE id = $1", [plan.id]);

    const { rows: created } = await client.query(
      `INSERT INTO perf_plans (month, version, status, supersedes_plan_id, created_by, submitted_by, submitted_at, approved_by, approved_at, revision_reason)
       VALUES ($1, $2, 'approved', $3, $4, $4, now(), $4, now(), $5)
       RETURNING *`,
      [plan.month, plan.version + 1, plan.id, req.user.id, reason.trim()]
    );
    const revision = created[0];

    await client.query(
      `INSERT INTO perf_plan_targets (plan_id, channel_id, sales_target_amd, collection_target_amd, new_customers_target)
       SELECT $1, channel_id, sales_target_amd, collection_target_amd, new_customers_target FROM perf_plan_targets WHERE plan_id = $2`,
      [revision.id, plan.id]
    );
    await client.query(
      `INSERT INTO perf_plan_brand_targets (plan_id, channel_id, brand, target_liters)
       SELECT $1, channel_id, brand, target_liters FROM perf_plan_brand_targets WHERE plan_id = $2`,
      [revision.id, plan.id]
    );

    const changedChannels = [];
    for (const t of targets) {
      if (!Number.isInteger(t?.channel_id)) continue;
      const { rows: beforeRows } = await client.query(
        "SELECT * FROM perf_plan_targets WHERE plan_id = $1 AND channel_id = $2",
        [revision.id, t.channel_id]
      );
      const before = beforeRows[0] ?? null;
      const { rows: afterRows } = await client.query(
        `UPDATE perf_plan_targets SET
           sales_target_amd = COALESCE($3, sales_target_amd),
           collection_target_amd = COALESCE($4, collection_target_amd),
           new_customers_target = COALESCE($5, new_customers_target)
         WHERE plan_id = $1 AND channel_id = $2 RETURNING *`,
        [revision.id, t.channel_id, t.sales_target_amd, t.collection_target_amd, t.new_customers_target]
      );
      if (afterRows[0]) {
        changedChannels.push(t.channel_id);
        await writeAudit(client, revision.id, req.user.id, "revise_target", before, afterRows[0], reason.trim());
      }
    }

    await writeAudit(client, plan.id, req.user.id, "superseded", { status: "approved" }, { status: "superseded" }, reason.trim());

    await client.query("COMMIT");
    res.status(201).json(await loadPlanDetail(revision.id));

    (async () => {
      try {
        const notifyRoles = ["admin", "ceo", "sales_director", "accountant"];
        const { rows: notifyRecipients } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [notifyRoles]);
        for (const recipient of notifyRecipients) {
          if (recipient.id === req.user.id) continue;
          notifyUser(recipient.id, "perf_plan_reviewed", {
            title: "Performance plan revised by CEO",
            body: `The ${plan.month.toISOString?.() ?? plan.month} plan was revised: ${reason.trim()}`,
            url: "/#/team-performance/planning",
          });
        }
      } catch (err) {
        console.error("Post-perf-plan-revision notification failed:", err);
      }
    })();
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// All plans currently awaiting this reviewer's decision -- the Approval
// Center list.
teamPerformanceRouter.get("/approvals", async (req, res) => {
  if (!PERF_APPROVER_ROLES.includes(req.user.role)) return res.json([]);

  const { rows } = await pool.query(
    `SELECT p.id, p.month, p.version, p.submitted_at, u.name AS submitted_by_name, u.role AS submitted_by_role,
       (SELECT count(*)::int FROM perf_plan_targets t WHERE t.plan_id = p.id) AS channel_count
     FROM perf_plans p LEFT JOIN users u ON u.id = p.submitted_by
     WHERE p.status = 'pending_approval'
     ORDER BY p.submitted_at`
  );
  // Accountant only reviews Sales Director submissions -- filter here since
  // that's a single small list, not worth pushing into the SQL above.
  const visible = req.user.role === "accountant" ? rows.filter((r) => r.submitted_by_role === "sales_director") : rows;
  res.json(visible);
});

// One row per month with any plan history -- superseded rows are excluded
// so this always shows each month's current/latest state (draft, pending,
// approved, rejected, or closed). The History screen's month list.
teamPerformanceRouter.get("/history", async (req, res) => {
  if (!seesAllPerformance(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const { rows } = await pool.query(
    `SELECT p.id, p.month, p.version, p.status, p.closed_at,
       (SELECT count(*)::int FROM perf_plan_targets t WHERE t.plan_id = p.id) AS channel_count
     FROM perf_plans p
     WHERE p.status != 'superseded'
     ORDER BY p.month DESC`
  );
  res.json(rows);
});

// Freezes an approved plan's final numbers into perf_plan_closed_snapshot
// and marks it closed. Irreversible by design -- a closed month is the
// permanent historical record; if a real correction is needed later it
// happens in Excel and gets flagged there, per the no-duplicate-source-of-
// truth business rule this whole module is built against, not by reopening
// a closed month here.
teamPerformanceRouter.post("/plans/:id/close", async (req, res) => {
  if (!canCloseMonth(req.user.role)) {
    return res.status(403).json({ error: "Only the CEO or Accountant can close a month" });
  }

  const detail = await loadPlanDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: "Plan not found" });
  if (detail.status !== "approved") return res.status(409).json({ error: "Only an approved plan can be closed" });

  const monthStr = detail.month.toISOString().slice(0, 10);

  const brandTargetsByChannel = new Map();
  for (const bt of detail.brand_targets) {
    if (!brandTargetsByChannel.has(bt.channel_id)) brandTargetsByChannel.set(bt.channel_id, []);
    brandTargetsByChannel.get(bt.channel_id).push(bt);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const target of detail.targets) {
      const actuals = await loadChannelActuals(target.channel_code, monthStr);
      const brandTargets = brandTargetsByChannel.get(target.channel_id) ?? [];
      const brandTargetsByBrand = new Map(brandTargets.map((bt) => [bt.brand, Number(bt.target_liters)]));
      const brandActuals = actuals.brand_actuals.map((ba) => ({
        brand: ba.brand,
        liters: Number(ba.liters),
        target_liters: brandTargetsByBrand.get(ba.brand) ?? 0,
      }));
      // Brand targets with no recorded actual liters still belong in the
      // frozen snapshot (0 actual is a real outcome, not a missing one).
      for (const [brand, targetLiters] of brandTargetsByBrand) {
        if (!brandActuals.some((ba) => ba.brand === brand)) {
          brandActuals.push({ brand, liters: 0, target_liters: targetLiters });
        }
      }

      await client.query(
        `INSERT INTO perf_plan_closed_snapshot
           (plan_id, channel_id, channel_code, channel_name, sales_target_amd, sales_actual_amd,
            collection_target_amd, collection_actual_amd, new_customers_target, new_customers_actual, brand_actuals)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (plan_id, channel_id) DO NOTHING`,
        [
          detail.id,
          target.channel_id,
          target.channel_code,
          target.channel_name,
          target.sales_target_amd,
          actuals.sales_actual,
          target.collection_target_amd,
          actuals.collected_confirmed,
          target.new_customers_target,
          actuals.new_customers_actual,
          JSON.stringify(brandActuals),
        ]
      );
    }

    const { rows: updated } = await client.query(
      `UPDATE perf_plans SET status = 'closed', closed_by = $1, closed_at = now(), lock_version = lock_version + 1, updated_at = now()
       WHERE id = $2 RETURNING *`,
      [req.user.id, detail.id]
    );
    await writeAudit(client, detail.id, req.user.id, "close", { status: "approved" }, { status: "closed" });

    await client.query("COMMIT");
    res.json(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// Data Quality: surfaces the configuration gaps that make a channel's
// numbers wrong or invisible on this module's dashboards -- not a general
// data-integrity audit of the whole app, just the handful of things that
// break Team Performance specifically. Every check here is a cheap,
// read-only query against small tables; nothing here recomputes actuals.
teamPerformanceRouter.get("/data-quality", async (req, res) => {
  if (!seesAllPerformance(req.user.role)) return res.status(403).json({ error: "Not allowed" });

  const [
    { rows: unmappedSalesReps },
    { rows: unmappedErpReps },
    { rows: staleChannels },
    { rows: unassignedChannels },
  ] = await Promise.all([
    // A rep_name in the Excel-sourced sales_performance table that doesn't
    // match any configured sales_channels.code -- that channel's Sales/
    // Collections numbers are being synced but have nowhere to land, so
    // they're silently absent from every Team Performance dashboard.
    pool.query(
      `SELECT DISTINCT sp.rep_name, max(sp.month) AS latest_month, max(sp.synced_at) AS latest_sync
       FROM sales_performance sp
       WHERE NOT EXISTS (SELECT 1 FROM sales_channels c WHERE c.code = sp.rep_name)
       GROUP BY sp.rep_name ORDER BY sp.rep_name`
    ),
    // Same idea for the customer/debt feed -- an assigned_sales_rep with no
    // matching channel means that rep's customers can never be counted as
    // "new customers" for any channel.
    pool.query(
      `SELECT DISTINCT assigned_sales_rep, count(*)::int AS customer_count
       FROM erp_customer_data
       WHERE assigned_sales_rep IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM sales_channels c WHERE c.code = erp_customer_data.assigned_sales_rep)
       GROUP BY assigned_sales_rep ORDER BY assigned_sales_rep`
    ),
    // An active channel with no sales_performance sync at all in the last
    // 45 days -- the Excel pipeline may have stopped sending this channel's
    // numbers, which would otherwise look identical to "genuinely zero"
    // sales on the dashboard.
    pool.query(
      `SELECT c.id, c.code, c.name, max(sp.synced_at) AS latest_sync
       FROM sales_channels c
       LEFT JOIN sales_performance sp ON sp.rep_name = c.code
       WHERE c.active
       GROUP BY c.id, c.code, c.name
       HAVING max(sp.synced_at) IS NULL OR max(sp.synced_at) < now() - interval '45 days'
       ORDER BY c.display_order`
    ),
    // A sales_director-owned channel with no manager_user_id -- plannable
    // and approvable, but nobody in the app is actually accountable for it.
    pool.query(
      `SELECT id, code, name FROM sales_channels
       WHERE active AND owner_role = 'sales_director' AND manager_user_id IS NULL
       ORDER BY display_order`
    ),
  ]);

  res.json({ unmappedSalesReps, unmappedErpReps, staleChannels, unassignedChannels });
});

// Company-wide brand-volume actuals (liters), aggregated across every
// channel and grouped by month/brand -- there's no existing endpoint that
// rolls perf_actuals_brand_monthly up past a single channel (loadChannelActuals
// above is always scoped to one channel_code), so this is a small, purpose-
// built read for the Company Dashboard's brand-volume section.
teamPerformanceRouter.get("/brand-actuals-summary", async (req, res) => {
  if (!seesAllPerformance(req.user.role)) return res.status(403).json({ error: "Not allowed" });

  const { rows } = await pool.query(
    `SELECT month, brand, sum(liters)::numeric AS liters
     FROM perf_actuals_brand_monthly
     WHERE month >= date_trunc('year', now())
     GROUP BY month, brand
     ORDER BY month, brand`
  );
  res.json(rows);
});
