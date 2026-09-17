// Template CRUD for the Bonuses challenge engine (bonus_challenge_templates,
// bonus_challenge_template_targets, bonus_challenge_product_targets --
// migrations/076_bonuses_schema.sql). A template is freely editable while
// status='draft'; publishing snapshots it into rounds (bonusChallengeRounds.js)
// from that point on, so this module never edits a published template's
// rule-bearing fields -- only status transitions (publish/cancel) are legal
// past draft, per the brief's "Published rounds are immutable" requirement.
import { pool } from "./db/pool.js";

const TYPES = ["single_metric", "balanced_basket", "product_sales"];
const AUDIENCE_MODES = ["individual", "selected_users", "selected_roles"];
const RECURRENCES = ["once", "daily", "weekly", "monthly", "yearly"];
const METRICS = ["strawberry", "carrot", "apple", "cherry", "points"];

function validateCreate(input) {
  if (!input.title || typeof input.title !== "string") throw new Error("title is required");
  if (!TYPES.includes(input.type)) throw new Error(`type must be one of ${TYPES.join(", ")}`);
  if (!AUDIENCE_MODES.includes(input.audienceMode)) throw new Error(`audienceMode must be one of ${AUDIENCE_MODES.join(", ")}`);
  if (!RECURRENCES.includes(input.recurrence)) throw new Error(`recurrence must be one of ${RECURRENCES.join(", ")}`);
  if (input.audienceMode === "selected_roles") {
    if (!Array.isArray(input.audienceRoles) || !input.audienceRoles.length) throw new Error("audienceRoles is required for selected_roles");
  } else if (!Array.isArray(input.audienceUserIds) || !input.audienceUserIds.length) {
    throw new Error("audienceUserIds is required for individual/selected_users");
  }
  if (!Number.isInteger(input.validationGraceDays) || input.validationGraceDays <= 0) {
    throw new Error("validationGraceDays must be a positive integer");
  }
  if (input.type === "single_metric" || input.type === "balanced_basket") {
    if (!Array.isArray(input.targets) || !input.targets.length) throw new Error("targets is required for single_metric/balanced_basket");
    if (input.type === "single_metric" && input.targets.length !== 1) throw new Error("single_metric takes exactly one target");
    for (const t of input.targets) {
      if (!METRICS.includes(t.metric)) throw new Error(`target metric must be one of ${METRICS.join(", ")}`);
      if (!Number.isInteger(t.targetScaled) || t.targetScaled <= 0) throw new Error("target targetScaled must be a positive integer");
    }
  }
  if (input.type === "product_sales") {
    if (!Array.isArray(input.productTargets) || !input.productTargets.length) throw new Error("productTargets is required for product_sales");
    for (const p of input.productTargets) {
      if (!p.productNameSnapshot) throw new Error("productTargets[].productNameSnapshot is required");
      if (!Number.isInteger(p.targetPieces) || p.targetPieces <= 0) throw new Error("productTargets[].targetPieces must be a positive integer");
    }
  }
}

export async function createDraftTemplate(input, createdBy) {
  validateCreate(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO bonus_challenge_templates (
         title, description, type, audience_mode, audience_user_ids, audience_roles, recurrence,
         custom_start_date, custom_end_date, reward_amd, watermelon_point_value, validation_grace_days,
         first_round_policy, scheduled_start_at, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        input.title,
        input.description ?? null,
        input.type,
        input.audienceMode,
        input.audienceMode === "selected_roles" ? null : input.audienceUserIds,
        input.audienceMode === "selected_roles" ? input.audienceRoles : null,
        input.recurrence,
        input.customStartDate ?? null,
        input.customEndDate ?? null,
        input.rewardAmd ?? null,
        input.watermelonPointValue ?? null,
        input.validationGraceDays,
        input.firstRoundPolicy ?? "publish_forward",
        input.scheduledStartAt ?? null,
        createdBy ?? null,
      ]
    );
    const template = rows[0];

    if (template.type === "single_metric" || template.type === "balanced_basket") {
      for (const t of input.targets) {
        await client.query(
          "INSERT INTO bonus_challenge_template_targets (template_id, metric, target_scaled) VALUES ($1, $2, $3)",
          [template.id, t.metric, t.targetScaled]
        );
      }
    }
    if (template.type === "product_sales") {
      for (const p of input.productTargets) {
        await client.query(
          `INSERT INTO bonus_challenge_product_targets (template_id, product_id, product_name_snapshot, product_unit_snapshot, target_pieces)
           VALUES ($1, $2, $3, $4, $5)`,
          [template.id, p.productId ?? null, p.productNameSnapshot, p.productUnitSnapshot ?? null, p.targetPieces]
        );
      }
    }
    await client.query("COMMIT");
    return getTemplate(template.id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getTemplate(id) {
  const { rows } = await pool.query("SELECT * FROM bonus_challenge_templates WHERE id = $1", [id]);
  const template = rows[0];
  if (!template) return null;
  const { rows: targets } = await pool.query("SELECT * FROM bonus_challenge_template_targets WHERE template_id = $1", [id]);
  const { rows: productTargets } = await pool.query("SELECT * FROM bonus_challenge_product_targets WHERE template_id = $1", [id]);
  return { ...template, targets, productTargets };
}

export async function listTemplates({ status } = {}) {
  const { rows } = await pool.query(
    status ? "SELECT * FROM bonus_challenge_templates WHERE status = $1 ORDER BY created_at DESC" : "SELECT * FROM bonus_challenge_templates ORDER BY created_at DESC",
    status ? [status] : []
  );
  return rows;
}

// Publishing is the one-way door: from this point on, bonusChallengeRounds.js
// snapshots this template's targets/audience/reward into each round it
// generates, and this module refuses to change any of those rule-bearing
// fields on a non-draft template (title/description are cosmetic and stay
// editable, since they carry no scoring meaning).
export async function publishTemplate(id, publishedBy) {
  const { rows } = await pool.query(
    `UPDATE bonus_challenge_templates SET status = 'published', published_at = now()
     WHERE id = $1 AND status = 'draft' RETURNING *`,
    [id]
  );
  if (!rows[0]) throw new Error(`publishTemplate: template ${id} is not a draft (or does not exist)`);
  return rows[0];
}

export async function cancelTemplate(id, cancelledBy, reason) {
  const { rows } = await pool.query(
    `UPDATE bonus_challenge_templates SET status = 'cancelled', cancelled_by = $2, cancelled_at = now(), cancelled_reason = $3
     WHERE id = $1 AND status <> 'cancelled' RETURNING *`,
    [id, cancelledBy ?? null, reason ?? null]
  );
  if (!rows[0]) throw new Error(`cancelTemplate: template ${id} not found or already cancelled`);
  return rows[0];
}

export async function updateDraftTemplate(id, updates) {
  const { rows: existingRows } = await pool.query("SELECT status FROM bonus_challenge_templates WHERE id = $1", [id]);
  if (!existingRows[0]) throw new Error(`updateDraftTemplate: template ${id} not found`);
  if (existingRows[0].status !== "draft") throw new Error(`updateDraftTemplate: template ${id} is not a draft`);

  const fields = [];
  const values = [];
  let i = 1;
  for (const [column, value] of Object.entries({
    title: updates.title,
    description: updates.description,
    reward_amd: updates.rewardAmd,
    watermelon_point_value: updates.watermelonPointValue,
    validation_grace_days: updates.validationGraceDays,
  })) {
    if (value === undefined) continue;
    fields.push(`${column} = $${i}`);
    values.push(value);
    i += 1;
  }
  if (!fields.length) return getTemplate(id);
  values.push(id);
  await pool.query(`UPDATE bonus_challenge_templates SET ${fields.join(", ")}, updated_at = now() WHERE id = $${i}`, values);
  return getTemplate(id);
}
