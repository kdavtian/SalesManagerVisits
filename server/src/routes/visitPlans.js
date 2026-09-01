import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { canPlanForOthers } from "../roles.js";
import { notifyTelegram, escapeHtml } from "../telegram.js";
import { notifyUser } from "../notifications.js";
import { APPROVER_ROLES } from "../notificationPreferences.js";

export const visitPlansRouter = Router();

visitPlansRouter.use(requireAuth);

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Resolves which user_id a plan/rule request targets, enforcing that only
// canPlanForOthers roles may target someone other than themselves.
function resolveTargetUserId(req, res, rawUserId) {
  const targetId = rawUserId ? Number(rawUserId) : req.user.id;
  if (!Number.isInteger(targetId)) {
    res.status(400).json({ error: "user_id must be an integer" });
    return null;
  }
  if (targetId !== req.user.id && !canPlanForOthers(req.user.role)) {
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
// once a team has more than a couple of recurring rules).
async function batchExpandAreas(rules) {
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
  const customerIds = [...new Set([...areaIds, ...(rule.customer_ids ?? [])])];
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
  // A reorder (same customers, different sequence) isn't a content change --
  // don't make an already-approved plan drop back to pending just because
  // the rep dragged their stops into a different visiting order.
  const isReorderOnly =
    existing &&
    existing.status === "approved" &&
    existing.customer_ids.length === customerIds.length &&
    new Set(existing.customer_ids).size === new Set(customerIds).size &&
    customerIds.every((id) => existing.customer_ids.includes(id));

  const autoApprove = isReorderOnly || req.user.role === "admin" || targetId !== req.user.id;
  const status = autoApprove ? "approved" : "pending";
  const reviewedBy = isReorderOnly ? existing.reviewed_by : autoApprove ? req.user.id : null;
  const reviewedAt = isReorderOnly ? existing.reviewed_at : autoApprove ? new Date() : null;

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
            title: "Plan needs review",
            body: `${repName} submitted a plan for ${date} (${customerIds.length} stop${customerIds.length === 1 ? "" : "s"}).`,
            url: "/#/settings",
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
  const targetId = resolveTargetUserId(req, res, req.query.user_id);
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

  const { rows } = await pool.query(
    `INSERT INTO visit_plan_rules (user_id, day_of_week, areas, customer_ids, created_by, active)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, day_of_week) DO UPDATE
       SET areas = EXCLUDED.areas, customer_ids = EXCLUDED.customer_ids,
           active = EXCLUDED.active, created_by = EXCLUDED.created_by, updated_at = now()
     RETURNING *`,
    [targetId, dayOfWeek, JSON.stringify(areas), customerIds, req.user.id, areas.length > 0 || customerIds.length > 0]
  );
  res.status(201).json(rows[0]);
});

// Full weekday x rep grid for the Route Plans overview page -- one request
// instead of N+1 per sales manager. Only sales_manager-role users are
// route-planned targets (matches /users/plannable); customer_count is
// precomputed here so the overview grid doesn't need to expand areas for
// every cell just to show a number.
visitPlansRouter.get("/rules/overview", requireCanPlanForOthers, async (req, res) => {
  const { rows: reps } = await pool.query(
    "SELECT id, name, position FROM users WHERE role = 'sales_manager' ORDER BY name"
  );
  const { rows: rules } = await pool.query(
    "SELECT * FROM visit_plan_rules WHERE active ORDER BY day_of_week"
  );

  const areaIdsByRule = await batchExpandAreas(rules);

  const rulesByUser = new Map();
  for (const rule of rules) {
    if (!rulesByUser.has(rule.user_id)) rulesByUser.set(rule.user_id, []);
    const areaIds = areaIdsByRule.get(rule.id);
    const customerIds = new Set([...areaIds, ...(rule.customer_ids ?? [])]);
    rulesByUser.get(rule.user_id).push({
      day_of_week: rule.day_of_week,
      customer_ids: rule.customer_ids ?? [],
      areas: rule.areas ?? [],
      customer_count: customerIds.size,
    });
  }

  res.json(
    reps.map((rep) => ({
      user_id: rep.id,
      user_name: rep.name,
      position: rep.position,
      days: rulesByUser.get(rep.id) ?? [],
    }))
  );
});

// Review queue -- any role that can plan for others (admin, sales_director,
// ceo), not just admin: a director needs to be able to approve their own
// reps' self-authored plans without waiting on a superadmin account.
function requireCanPlanForOthers(req, res, next) {
  if (!canPlanForOthers(req.user.role)) return res.status(403).json({ error: "Not allowed" });
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
          const dateLabel = new Date(updated[0].plan_date).toLocaleDateString();
          notifyUser(updated[0].user_id, "plan_reviewed", {
            title: action === "approve" ? "Visit plan approved" : "Visit plan rejected",
            body:
              action === "approve"
                ? `Your plan for ${dateLabel} was approved.`
                : `Your plan for ${dateLabel} was rejected -- please revise it.`,
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
