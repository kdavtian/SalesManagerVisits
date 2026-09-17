// Progress computation for an active round (bonus_progress --
// migrations/076_bonuses_schema.sql). Rebuildable projection only, per the
// table's own migration comment ("never the sole financial authority") --
// recomputed from the ledger/contributions on every worker tick, never
// itself the source of what a reward pays out. A balanced_basket or
// product_sales round only reaches "target_reached" when EVERY configured
// component is met, per the brief's "requires ALL configured components,
// not an average or sum."
import { pool } from "./db/pool.js";

async function confirmedForMetric(userId, metric, startAt, endAt) {
  const column = metric === "points" ? "points_delta_scaled" : "collectible_delta_scaled";
  const activityFilter = metric === "points" ? "" : "AND activity = $4";
  const params = metric === "points" ? [userId, startAt, endAt] : [userId, startAt, endAt, metric];
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(${column}), 0) AS total FROM bonus_point_ledger
     WHERE user_id = $1 AND created_at >= $2 AND created_at < $3 ${activityFilter}`,
    params
  );
  return Math.max(0, Number(rows[0].total));
}

async function confirmedForProductTarget(roundId, userId, productTargetId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(net_pieces), 0) AS total FROM bonus_product_challenge_contributions
     WHERE round_id = $1 AND user_id = $2 AND product_target_id = $3 AND status = 'qualifying'`,
    [roundId, userId, productTargetId]
  );
  return Math.max(0, Number(rows[0].total));
}

// Computes and upserts one participant's progress for one round. Returns
// the updated bonus_progress row.
export async function recomputeParticipantProgress(round, userId) {
  const rules = round.snapshot_rules;
  const componentProgress = {};
  let allReached = true;

  if (rules.type === "product_sales") {
    for (const target of rules.productTargets) {
      const confirmedScaled = await confirmedForProductTarget(round.id, userId, target.id);
      const reached = confirmedScaled >= target.target_pieces;
      componentProgress[`product:${target.id}`] = { confirmed_scaled: confirmedScaled, target_scaled: target.target_pieces, label: target.product_name_snapshot };
      if (!reached) allReached = false;
    }
  } else {
    for (const target of rules.targets) {
      const confirmedScaled = await confirmedForMetric(userId, target.metric, round.start_at, round.end_at);
      const reached = confirmedScaled >= target.target_scaled;
      componentProgress[target.metric] = { confirmed_scaled: confirmedScaled, target_scaled: target.target_scaled };
      if (!reached) allReached = false;
    }
  }

  const { rows: existingRows } = await pool.query("SELECT * FROM bonus_progress WHERE round_id = $1 AND user_id = $2", [round.id, userId]);
  const existing = existingRows[0];
  const overallStatus = allReached ? "target_reached" : "in_progress";
  const reachedAt = allReached ? (existing?.reached_at ?? new Date()) : null;

  const { rows } = await pool.query(
    `INSERT INTO bonus_progress (round_id, user_id, component_progress, overall_status, reached_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (round_id, user_id) DO UPDATE SET
       component_progress = EXCLUDED.component_progress,
       overall_status = EXCLUDED.overall_status,
       reached_at = COALESCE(bonus_progress.reached_at, EXCLUDED.reached_at),
       updated_at = now()
     RETURNING *`,
    [round.id, userId, JSON.stringify(componentProgress), overallStatus, reachedAt]
  );
  return rows[0];
}

export async function recomputeRoundProgress(round) {
  const { rows } = await pool.query("SELECT user_id FROM bonus_round_participants WHERE round_id = $1", [round.id]);
  const results = [];
  for (const { user_id: userId } of rows) {
    results.push(await recomputeParticipantProgress(round, userId));
  }
  return results;
}

export async function getProgress(roundId, userId) {
  const { rows } = await pool.query("SELECT * FROM bonus_progress WHERE round_id = $1 AND user_id = $2", [roundId, userId]);
  return rows[0] ?? null;
}
