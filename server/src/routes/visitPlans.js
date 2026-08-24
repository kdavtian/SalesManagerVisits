import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { canPlanForOthers } from "../roles.js";

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

  const customerIds = await expandAreas(rule.areas);
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

// Upsert the rule for one weekday. An empty areas array deactivates it
// (kept as a row, not deleted, so the "who set this up" audit trail via
// created_by survives a rep clearing their own cycle).
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

  const { rows } = await pool.query(
    `INSERT INTO visit_plan_rules (user_id, day_of_week, areas, created_by, active)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, day_of_week) DO UPDATE
       SET areas = EXCLUDED.areas, active = EXCLUDED.active, created_by = EXCLUDED.created_by, updated_at = now()
     RETURNING *`,
    [targetId, dayOfWeek, JSON.stringify(areas), req.user.id, areas.length > 0]
  );
  res.status(201).json(rows[0]);
});

// Review queue -- admin only.
visitPlansRouter.get("/pending", requireAdmin, async (req, res) => {
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

// Approve/reject a pending plan, or (admin only) directly edit and
// auto-approve an existing one -- "admin can change it later".
visitPlansRouter.patch("/:id", requireAdmin, async (req, res) => {
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
  } catch (err) {
    releaseErr = err;
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release(releaseErr);
  }
});
