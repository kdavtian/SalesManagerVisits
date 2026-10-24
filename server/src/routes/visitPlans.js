import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { canPlanForOthers, canViewAllRoutePlans, canViewTeamLocations } from "../roles.js";
import { notifyTelegram, escapeHtml } from "../telegram.js";
import { notifyUser } from "../notifications.js";
import { APPROVER_ROLES } from "../notificationPreferences.js";
import { repVisitSql } from "../visitCount.js";
import { NOT_NO_VISIT_CHANNEL_SQL } from "./customers.js";
import { dropRecentlyVisited } from "../utils/planSkipRecent.js";
import { MAIN_SCOPE, parseScope, loadChannelMap, inScope, mergeScopeIds, scopesFor } from "../planScopes.js";

export const visitPlansRouter = Router();

// plan_date comes back from Postgres as a plain "YYYY-MM-DD" string (a
// `date` column, no time component). `new Date(dateStr)` parses that as
// UTC midnight, which .toLocaleDateString() then renders as the PREVIOUS
// day whenever this process's own timezone (TZ env / host default) is
// behind UTC -- reading the y/m/d digits straight out of the string and
// building a local Date from them avoids the UTC round-trip entirely.
function formatPlanDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!match) return String(value);
  const [, yyyy, mm, dd] = match;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd)).toLocaleDateString();
}

visitPlansRouter.use(requireAuth);

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Resolves which user_id a plan/rule request targets, enforcing that only
// canPlanForOthers roles may target someone other than themselves.
function resolveTargetUserId(req, res, rawUserId, { readOnly = false } = {}) {
  const targetId = rawUserId ? Number(rawUserId) : req.user.id;
  if (!Number.isInteger(targetId)) {
    res.status(400).json({ error: "user_id must be an integer" });
    return null;
  }
  if (targetId !== req.user.id && !(readOnly ? canViewAllRoutePlans(req.user.role) : canPlanForOthers(req.user.role))) {
    res.status(403).json({ error: "Not allowed to plan for this user" });
    return null;
  }
  return targetId;
}

async function expandAreas(areas) {
  if (!Array.isArray(areas) || !areas.length) return [];
  const ids = new Set();
  for (const area of areas) {
    if (!area?.region) continue;
    const params = [area.region];
    let subregionFilter = "";
    if (area.subregion) {
      params.push(area.subregion);
      subregionFilter = `AND subregion = $${params.length}`;
    }
    const { rows } = await pool.query(`SELECT id FROM customers WHERE region = $1 ${subregionFilter}`, params);
    rows.forEach((r) => ids.add(r.id));
  }
  return [...ids];
}

// Same expansion as expandAreas(), but for many rules at once -- one query
// for every customer's region/subregion instead of one query per area per
// rule per rep, which is what the overview endpoint used to do (a real N+1
// once a team has more than a couple of recurring rules). Exported for
// dashboard.js's week-to-date planned-vs-actual figure, which needs the
// same batch expansion across every rep's rules for the week so far.
export async function batchExpandAreas(rules) {
  const result = new Map(rules.map((rule) => [rule.id, new Set()]));
  if (!rules.some((rule) => Array.isArray(rule.areas) && rule.areas.length)) return result;
  const { rows: customers } = await pool.query("SELECT id, region, subregion FROM customers");
  for (const rule of rules) {
    if (!Array.isArray(rule.areas) || !rule.areas.length) continue;
    const ids = result.get(rule.id);
    for (const area of rule.areas) {
      if (!area?.region) continue;
      for (const c of customers) {
        if (c.region !== area.region) continue;
        if (area.subregion && c.subregion !== area.subregion) continue;
        ids.add(c.id);
      }
    }
  }
  return result;
}

// The target user's plan for a date (defaults to today): an explicit
// visit_plans row always wins; otherwise an active recurring rule for that
// weekday is expanded live into a synthesized (non-persisted) plan.
visitPlansRouter.get("/mine", async (req, res) => {
  const targetId = resolveTargetUserId(req, res, req.query.user_id);
  if (targetId === null) return;
  const date = isValidDate(req.query.date) ? req.query.date : todayDate();

  const { rows } = await pool.query("SELECT * FROM visit_plans WHERE user_id = $1 AND plan_date = $2", [
    targetId,
    date,
  ]);
  if (rows[0]) return res.json(rows[0]);

  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
  const { rows: ruleRows } = await pool.query(
    "SELECT * FROM visit_plan_rules WHERE user_id = $1 AND day_of_week = $2 AND active",
    [targetId, dayOfWeek]
  );
  const rule = ruleRows[0];
  if (!rule) return res.json(null);

  const areaIds = await expandAreas(rule.areas);
  // A customer visited 1..N days ago is left out of this rule day (see utils/planSkipRecent.js).
  const customerIds = await dropRecentlyVisited(new Set([...areaIds, ...(rule.customer_ids ?? [])]), date);
  res.json({
    id: null,
    user_id: targetId,
    plan_date: date,
    customer_ids: customerIds,
    status: "approved",
    source: "rule",
    rule_id: rule.id,
  });
});

// Today's plan for every sales_manager at once, grouped by manager --
// management's own "who's going where today" view (Home tab's Team Today
// section, under the Monthly Leaders points board). Same per-user
// resolution as GET /mine above (an explicit visit_plans row wins,
// otherwise the day's active recurring rule expanded live), just batched
// across the whole team in a handful of queries instead of one /mine call
// per rep. Read-only and admin/director/ceo-gated the same way the Map's
// team-locations view already is -- this is the same "where is the team
// right now" concern, just plan-of-record instead of live GPS.
visitPlansRouter.get("/team-today", async (req, res) => {
  if (!canViewTeamLocations(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const date = todayDate();

  const { rows: managers } = await pool.query(
    "SELECT id, name FROM users WHERE role = 'sales_manager' AND status = 'active' ORDER BY name"
  );
  if (!managers.length) return res.json([]);
  const managerIds = managers.map((m) => m.id);

  const { rows: planRows } = await pool.query(
    "SELECT * FROM visit_plans WHERE user_id = ANY($1) AND plan_date = $2",
    [managerIds, date]
  );
  const planByUser = new Map(planRows.map((p) => [p.user_id, p]));

  const missingIds = managerIds.filter((id) => !planByUser.has(id));
  let ruleRows = [];
  if (missingIds.length) {
    const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
    ({ rows: ruleRows } = await pool.query(
      "SELECT * FROM visit_plan_rules WHERE user_id = ANY($1) AND day_of_week = $2 AND active",
      [missingIds, dayOfWeek]
    ));
  }
  const ruleByUser = new Map(ruleRows.map((r) => [r.user_id, r]));
  const expandedByRule = await batchExpandAreas(ruleRows);

  const customerIdsByManager = new Map();
  const allCustomerIds = new Set();
  for (const m of managers) {
    const plan = planByUser.get(m.id);
    const rule = ruleByUser.get(m.id);
    const ids = plan
      ? (plan.customer_ids ?? [])
      : rule
        ? await dropRecentlyVisited(new Set([...(expandedByRule.get(rule.id) ?? []), ...(rule.customer_ids ?? [])]), date)
        : [];
    customerIdsByManager.set(m.id, ids);
    ids.forEach((id) => allCustomerIds.add(id));
  }

  // Same "checked in today" definition GET /customers already uses --
  // kept as its own query (rather than joining through customers.js) so
  // this endpoint stays a single self-contained read.
  const { rows: customerRows } = allCustomerIds.size
    ? await pool.query(
        `SELECT id, name,
           EXISTS (SELECT 1 FROM checkins ch WHERE ch.customer_id = c.id AND ${repVisitSql("ch")} AND ch.timestamp >= date_trunc('day', now())) AS visited_today
         FROM customers c WHERE id = ANY($1)`,
        [[...allCustomerIds]]
      )
    : { rows: [] };
  const customerById = new Map(customerRows.map((c) => [c.id, c]));

  res.json(
    managers.map((m) => ({
      user_id: m.id,
      user_name: m.name,
      customers: (customerIdsByManager.get(m.id) ?? [])
        .map((id) => customerById.get(id))
        .filter(Boolean)
        .map((c) => ({ id: c.id, name: c.name, visited_today: c.visited_today })),
    }))
  );
});

// Create or replace a plan for a date, for self or (canPlanForOthers) for
// someone else. Admin-authored plans, and any plan authored for someone
// else by a canPlanForOthers role, are auto-approved -- the same trust
// level as an admin editing a plan directly today.
visitPlansRouter.post("/", async (req, res) => {
  const targetId = resolveTargetUserId(req, res, req.body?.user_id);
  if (targetId === null) return;
  const date = isValidDate(req.body?.date) ? req.body.date : todayDate();
  const customerIds = Array.isArray(req.body?.customer_ids)
    ? [...new Set(req.body.customer_ids.map(Number).filter(Number.isInteger))]
    : [];

  const { rows: existingRows } = await pool.query(
    "SELECT * FROM visit_plans WHERE user_id = $1 AND plan_date = $2",
    [targetId, date]
  );
  const existing = existingRows[0];

  // What the rep currently sees as their "approved" plan for this date may
  // not be a persisted row at all -- GET /mine synthesizes one on the fly
  // from an active recurring rule when no explicit visit_plans row exists
  // yet. Without accounting for that here, the very first save against a
  // rule-derived day (e.g. dragging a stop to reorder it, or resubmitting
  // the identical rule-generated list) had no persisted "existing" row to
  // compare against, so it always looked like a brand-new plan and got
  // downgraded to "pending" -- silently clobbering the already-approved
  // plan the map's Planned filter had just been showing.
  let previousApprovedIds = null;
  if (existing) {
    if (existing.status === "approved") previousApprovedIds = existing.customer_ids;
  } else {
    const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();
    const { rows: ruleRows } = await pool.query(
      "SELECT * FROM visit_plan_rules WHERE user_id = $1 AND day_of_week = $2 AND active",
      [targetId, dayOfWeek]
    );
    const rule = ruleRows[0];
    if (rule) {
      const areaIds = await expandAreas(rule.areas);
      previousApprovedIds = [...new Set([...areaIds, ...(rule.customer_ids ?? [])])];
    }
  }

  // A reorder (same customers, different sequence) isn't a content change --
  // don't make an already-approved plan drop back to pending just because
  // the rep dragged their stops into a different visiting order.
  const isReorderOnly =
    previousApprovedIds !== null &&
    previousApprovedIds.length === customerIds.length &&
    new Set(previousApprovedIds).size === new Set(customerIds).size &&
    customerIds.every((id) => previousApprovedIds.includes(id));

  const autoApprove = isReorderOnly || req.user.role === "admin" || targetId !== req.user.id;
  const status = autoApprove ? "approved" : "pending";
  const reviewedBy = isReorderOnly ? (existing ? existing.reviewed_by : null) : autoApprove ? req.user.id : null;
  const reviewedAt = isReorderOnly ? (existing ? existing.reviewed_at : new Date()) : autoApprove ? new Date() : null;

  const { rows } = await pool.query(
    `INSERT INTO visit_plans (user_id, plan_date, customer_ids, status, created_by, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, plan_date) DO UPDATE
       SET customer_ids = EXCLUDED.customer_ids,
           status = EXCLUDED.status,
           reviewed_by = EXCLUDED.reviewed_by,
           reviewed_at = EXCLUDED.reviewed_at,
           updated_at = now()
     RETURNING *`,
    [targetId, date, customerIds, status, req.user.id, reviewedBy, reviewedAt]
  );
  res.status(201).json(rows[0]);

  (async () => {
    try {
      if (status === "pending") {
        const { rows: userRows } = await pool.query("SELECT name FROM users WHERE id = $1", [targetId]);
        const repName = userRows[0]?.name || "Someone";
        notifyTelegram(
          `📋 <b>Route plan needs review</b>\n${escapeHtml(repName)} — ${date}, ${customerIds.length} stop${customerIds.length === 1 ? "" : "s"}`
        );

        const { rows: approvers } = await pool.query("SELECT id FROM users WHERE role = ANY($1)", [APPROVER_ROLES]);
        for (const approver of approvers) {
          notifyUser(approver.id, "plan_submitted", {
            title: "Պլանը սպասում է վերանայման",
            body: `${repName}-ը ուղարկել է պլան ${date}-ի համար (${customerIds.length} կանգառ)։`,
            url: "/#/settings?section=plan-approvals",
          });
        }
      }
    } catch (err) {
      console.error("Post-plan-submit notification failed:", err);
    }
  })();
});

// --- Recurring rules ---

// A rep's own rules, or (canPlanForOthers) someone else's.
visitPlansRouter.get("/rules", async (req, res) => {
  const targetId = resolveTargetUserId(req, res, req.query.user_id, { readOnly: true });
  if (targetId === null) return;
  const { rows } = await pool.query(
    "SELECT * FROM visit_plan_rules WHERE user_id = $1 AND active ORDER BY day_of_week",
    [targetId]
  );
  res.json(rows);
});

// Upsert the rule for one weekday. Empty areas AND customer_ids deactivates
// it (kept as a row, not deleted, so the "who set this up" audit trail via
// created_by survives a rep clearing their own cycle). customer_ids is the
// direct-pick path used by the Route Plans page (straight from a rep's
// assigned customers); areas is the older region/subregion-based path,
// still used by the Map page's quick planner. A rule can carry either or
// both -- they're unioned together when the rule is expanded for a date.
visitPlansRouter.put("/rules/:dayOfWeek", async (req, res) => {
  const dayOfWeek = Number(req.params.dayOfWeek);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    return res.status(400).json({ error: "dayOfWeek must be 0-6" });
  }
  const targetId = resolveTargetUserId(req, res, req.body?.user_id);
  if (targetId === null) return;

  const areas = Array.isArray(req.body?.areas)
    ? req.body.areas
        .filter((a) => a && typeof a.region === "string" && a.region)
        .map((a) => ({ region: a.region, subregion: typeof a.subregion === "string" && a.subregion ? a.subregion : null }))
    : [];
  const customerIds = Array.isArray(req.body?.customer_ids)
    ? [...new Set(req.body.customer_ids.map(Number).filter(Number.isInteger))]
    : [];

  // One PLAN of a person (the main one, or a separately planned channel such as SM B2B): only that plan's customers are
  // replaced, the person's other plans on this weekday stay exactly as they are. Areas of the stored rule are turned
  // into plain customer ids first, so nothing of the other plans is lost. Without plan_channel the whole rule is
  // replaced (the Map's quick planner).
  let finalAreas = areas;
  let finalIds = customerIds;
  if (req.body?.plan_channel !== undefined) {
    const scope = parseScope(req.body.plan_channel);
    if (scope === null) return res.status(400).json({ error: "plan_channel is not a separately planned channel" });
    const { rows: existingRows } = await pool.query("SELECT areas, customer_ids FROM visit_plan_rules WHERE user_id = $1 AND day_of_week = $2", [targetId, dayOfWeek]);
    const existing = existingRows[0];
    const existingIds = existing ? [...new Set([...(await expandAreas(existing.areas)), ...(existing.customer_ids ?? [])])] : [];
    finalAreas = [];
    finalIds = mergeScopeIds({ existing: existingIds, submitted: customerIds, scope, channelOf: await loadChannelMap(pool) });
  }

  const { rows } = await pool.query(
    `INSERT INTO visit_plan_rules (user_id, day_of_week, areas, customer_ids, created_by, active)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, day_of_week) DO UPDATE
       SET areas = EXCLUDED.areas, customer_ids = EXCLUDED.customer_ids,
           active = EXCLUDED.active, created_by = EXCLUDED.created_by, updated_at = now()
     RETURNING *`,
    [targetId, dayOfWeek, JSON.stringify(finalAreas), finalIds, req.user.id, finalAreas.length > 0 || finalIds.length > 0]
  );
  res.status(201).json(rows[0]);
});

// Full weekday x rep grid for the Route Plans overview page -- one request
// instead of N+1 per sales manager. Only sales_manager-role users are
// route-planned targets (matches /users/plannable); customer_count is
// precomputed here so the overview grid doesn't need to expand areas for
// every cell just to show a number.
// Each person's recurring plans: the main plan, plus a separate plan for every specially planned channel (SM B2B) the
// person owns customers in. Rules stay one row per person and weekday; a plan's day shows only ITS customers.
async function buildRepPlans(repIds) {
  const { rows: rules } = await pool.query("SELECT * FROM visit_plan_rules WHERE active AND user_id = ANY($1) ORDER BY day_of_week", [repIds]);
  const areaIdsByRule = await batchExpandAreas(rules);
  // The grid badge counts only customers that are CURRENTLY assigned to that
  // rep: a rule can still list a customer who was reassigned to someone else
  // (or an area covering other reps' customers), and counting those left a
  // rep with a "1" on a weekday although no customer of his is on it.
  const { rows: assignedRows } = await pool.query(
    `SELECT c.id, c.assigned_manager_id, c.sales_channel, (${NOT_NO_VISIT_CHANNEL_SQL} AND COALESCE(c.customer_tier, '') <> 'competitor') AS needs_plan FROM customers c WHERE c.assigned_manager_id = ANY($1)`,
    [repIds]
  );
  const needsPlan = new Set(assignedRows.filter((r) => r.needs_plan).map((r) => r.id));
  const managerByCustomer = new Map(assignedRows.map((r) => [r.id, r.assigned_manager_id]));
  const channelOf = new Map(assignedRows.map((r) => [r.id, r.sales_channel]));
  const assignedByRep = new Map(repIds.map((id) => [id, []]));
  for (const r of assignedRows) assignedByRep.get(r.assigned_manager_id)?.push(r.id);
  const rulesByUser = new Map(repIds.map((id) => [id, []]));
  for (const rule of rules) rulesByUser.get(rule.user_id)?.push(rule);

  const result = new Map();
  for (const repId of repIds) {
    const scopes = scopesFor(assignedByRep.get(repId), channelOf);
    // Customers of the rep that are on NO weekday of any active rule (the red badge on the overview); channels that are never visited
    // in the field and competitors do not need a place in the plan.
    const planned = new Set();
    for (const rule of rulesByUser.get(repId)) for (const id of [...(areaIdsByRule.get(rule.id) ?? []), ...(rule.customer_ids ?? [])]) planned.add(id);
    result.set(
      repId,
      scopes.map((scope) => ({
        scope,
        unplanned_count: (assignedByRep.get(repId) ?? []).filter((id) => needsPlan.has(id) && inScope(id, scope, channelOf) && !planned.has(id)).length,
        days: rulesByUser.get(repId).map((rule) => {
          const all = new Set([...(areaIdsByRule.get(rule.id) ?? []), ...(rule.customer_ids ?? [])]);
          const own = [...all].filter((id) => managerByCustomer.get(id) === rule.user_id && inScope(id, scope, channelOf));
          return {
            day_of_week: rule.day_of_week,
            customer_ids: (rule.customer_ids ?? []).filter((id) => inScope(id, scope, channelOf)),
            areas: scope === MAIN_SCOPE ? rule.areas ?? [] : [],
            customer_count: own.length,
          };
        }),
      }))
    );
  }
  return result;
}

// Full weekday x rep grid for the Route Plans overview page -- one request
// instead of N+1 per sales manager. Only sales_manager-role users are
// route-planned targets (matches /users/plannable); customer_count is
// precomputed here so the overview grid doesn't need to expand areas for
// every cell just to show a number. `days` is the main plan (kept for older
// clients), `plans` lists every plan of the person (main + separate channels).
visitPlansRouter.get("/rules/overview", requireCanViewAllRoutePlans, async (req, res) => {
  const { rows: reps } = await pool.query(
    "SELECT id, name, position FROM users WHERE role = 'sales_manager' AND status = 'active' ORDER BY name"
  );
  const plansByRep = await buildRepPlans(reps.map((r) => r.id));
  res.json(
    reps.map((rep) => {
      const plans = plansByRep.get(rep.id);
      return { user_id: rep.id, user_name: rep.name, position: rep.position, days: plans[0].days, plans };
    })
  );
});

// One person's own plans (the "my week" view of a rep who is not allowed to see everybody's).
visitPlansRouter.get("/rules/plans", async (req, res) => {
  const targetId = resolveTargetUserId(req, res, req.query.user_id, { readOnly: true });
  if (targetId === null) return;
  res.json({ plans: (await buildRepPlans([targetId])).get(targetId) });
});

// Every customer assigned to one rep, each annotated with which weekday(s)
// (if any) an active rule currently covers them on -- what the Route Plans
// page's "View customers" sheet needs to answer "which customer is on which
// day, and which of my customers aren't on any day at all" in one read,
// rather than the caller cross-referencing per-day customer_ids itself.
// Unlike GET /rules (raw rows), this expands areas the same way
// /rules/overview does, so a customer covered only by a region/subregion
// rule (the Map page's quick-planner path) still shows up correctly instead
// of looking unplanned.
visitPlansRouter.get("/rules/customers", async (req, res) => {
  const targetId = resolveTargetUserId(req, res, req.query.user_id, { readOnly: true });
  if (targetId === null) return;

  // ?scope= (empty = main plan, "SM B2B" = that channel's separate plan) limits the list to one plan's customers.
  const scope = req.query.scope === undefined ? undefined : parseScope(req.query.scope);
  if (scope === null) return res.status(400).json({ error: "scope is not a separately planned channel" });
  const { rows: allCustomers } = await pool.query(
    `SELECT q.*,
            -- overdue = visited before, but longer ago than its visit rhythm (a never-visited customer is "never visited", not overdue, here)
            (q.requires_visit AND q.last_visit_at IS NOT NULL AND q.last_visit_at < now() - (q.visit_frequency_days || ' days')::interval) AS overdue
     FROM (
       SELECT c.id, c.name, c.region, c.subregion, c.sales_channel, c.customer_tier, c.visit_frequency_days,
              (SELECT max(ch.timestamp) FROM checkins ch WHERE ch.customer_id = c.id AND ${repVisitSql("ch")}) AS last_visit_at,
              ${NOT_NO_VISIT_CHANNEL_SQL} AS requires_visit
       FROM customers c WHERE c.assigned_manager_id = $1
     ) q ORDER BY q.name`,
    [targetId]
  );
  const channelOf = new Map(allCustomers.map((c) => [c.id, c.sales_channel]));
  const customers = (scope === undefined ? allCustomers : allCustomers.filter((c) => inScope(c.id, scope, channelOf))).map(({ sales_channel, ...rest }) => rest);

  const { rows: rules } = await pool.query(
    "SELECT * FROM visit_plan_rules WHERE user_id = $1 AND active",
    [targetId]
  );
  const areaIdsByRule = await batchExpandAreas(rules);

  const daysByCustomerId = new Map();
  for (const rule of rules) {
    const ids = new Set([...(areaIdsByRule.get(rule.id) ?? []), ...(rule.customer_ids ?? [])]);
    for (const id of ids) {
      if (!daysByCustomerId.has(id)) daysByCustomerId.set(id, []);
      daysByCustomerId.get(id).push(rule.day_of_week);
    }
  }

  res.json({
    customers: customers.map((c) => ({ ...c, days: (daysByCustomerId.get(c.id) ?? []).sort() })),
  });
});

// Review queue -- any role that can plan for others (admin, sales_director,
// ceo), not just admin: a director needs to be able to approve their own
// reps' self-authored plans without waiting on a superadmin account.
function requireCanPlanForOthers(req, res, next) {
  if (!canPlanForOthers(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  next();
}

function requireCanViewAllRoutePlans(req, res, next) {
  if (!canViewAllRoutePlans(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  next();
}

visitPlansRouter.get("/pending", requireCanPlanForOthers, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT vp.*, u.name AS user_name
     FROM visit_plans vp
     JOIN users u ON u.id = vp.user_id
     WHERE vp.status = 'pending'
     ORDER BY vp.plan_date ASC, vp.created_at ASC`
  );
  if (!rows.length) return res.json([]);

  const allCustomerIds = [...new Set(rows.flatMap((r) => r.customer_ids))];
  const { rows: customers } = allCustomerIds.length
    ? await pool.query("SELECT id, name FROM customers WHERE id = ANY($1)", [allCustomerIds])
    : { rows: [] };
  const nameById = new Map(customers.map((c) => [c.id, c.name]));

  res.json(
    rows.map((r) => ({
      ...r,
      customer_names: r.customer_ids.map((id) => nameById.get(id)).filter(Boolean),
    }))
  );
});

// Approve/reject a pending plan, or (admin/director/ceo only) directly edit
// and auto-approve an existing one -- "the reviewer can change it later".
visitPlansRouter.patch("/:id", requireCanPlanForOthers, async (req, res) => {
  const { action, customer_ids } = req.body ?? {};
  if (action === undefined && customer_ids === undefined) {
    return res.status(400).json({ error: "action or customer_ids is required" });
  }

  const client = await pool.connect();
  let releaseErr;
  try {
    await client.query("BEGIN");

    const { rows } = await client.query("SELECT * FROM visit_plans WHERE id = $1 FOR UPDATE", [
      req.params.id,
    ]);
    const plan = rows[0];
    if (!plan) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Plan not found" });
    }

    if (action !== undefined) {
      if (!["approve", "reject"].includes(action)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
      }
      if (plan.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "This plan was already reviewed" });
      }
    }

    const nextCustomerIds = Array.isArray(customer_ids)
      ? [...new Set(customer_ids.map(Number).filter(Number.isInteger))]
      : plan.customer_ids;
    const nextStatus = action === "reject" ? "rejected" : "approved";

    const { rows: updated } = await client.query(
      `UPDATE visit_plans
       SET customer_ids = $1, status = $2, reviewed_by = $3, reviewed_at = now(), updated_at = now()
       WHERE id = $4
       RETURNING *`,
      [nextCustomerIds, nextStatus, req.user.id, req.params.id]
    );

    await client.query("COMMIT");
    res.json(updated[0]);

    // Outside the transaction's own try/catch on purpose -- a failure here
    // must not trigger that catch's ROLLBACK (a no-op after COMMIT, but
    // still rethrows) and crash the handler after the response is sent.
    (async () => {
      try {
        if (action !== undefined) {
          const dateLabel = formatPlanDate(updated[0].plan_date);
          notifyUser(updated[0].user_id, "plan_reviewed", {
            title: action === "approve" ? "Այցելության պլանը հաստատվեց" : "Այցելության պլանը մերժվեց",
            body:
              action === "approve"
                ? `Ձեր ${dateLabel} պլանը հաստատվել է։`
                : `Ձեր ${dateLabel} պլանը մերժվել է -- խնդրում ենք վերանայել այն։`,
            url: "/#/map",
          });
        }
      } catch (err) {
        console.error("Post-plan-review notification failed:", err);
      }
    })();
  } catch (err) {
    releaseErr = err;
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release(releaseErr);
  }
});
