// bonus_point_ledger (migrations/076_bonuses_schema.sql): the single
// append-only source of truth for every point/collectible change. Every
// write goes through postLedgerEntry below, keyed by a deterministic
// operation_key -- a retried ingestion (an outbox worker, a duplicate
// webhook, a re-run reconciliation sweep) computes the same key for the
// same logical event, and the table's UNIQUE(operation_key) constraint
// turns the retry into a no-op rather than a duplicate award. Nothing here
// is ever UPDATEd or DELETEd -- the table's own BEFORE UPDATE trigger
// enforces that at the database level (see 076's comment on it).
import { insertIdempotent } from "./bonusIdempotency.js";

// Posts one ledger row. Returns { row, alreadyPosted } -- alreadyPosted is
// true when operation_key already existed, meaning this exact logical event
// was already recorded by an earlier call (this one, or a concurrent/
// retried one) and nothing new was written.
export async function postLedgerEntry(
  client,
  {
    userId,
    activity,
    collectibleDeltaScaled,
    pointsDeltaScaled,
    ruleVersionId = null,
    sourceContributionId = null,
    attendanceId = null,
    challengeAwardId = null,
    operationKey,
    reason = null,
    createdBy = null,
  }
) {
  const { row, alreadyExisted } = await insertIdempotent(client, {
    insertSql: `INSERT INTO bonus_point_ledger (
         user_id, activity, collectible_delta_scaled, points_delta_scaled, rule_version_id,
         source_contribution_id, attendance_id, challenge_award_id, operation_key, reason, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
    insertParams: [
      userId,
      activity,
      collectibleDeltaScaled,
      pointsDeltaScaled,
      ruleVersionId,
      sourceContributionId,
      attendanceId,
      challengeAwardId,
      operationKey,
      reason,
      createdBy,
    ],
    conflictSelectSql: "SELECT * FROM bonus_point_ledger WHERE operation_key = $1",
    conflictSelectParams: [operationKey],
  });
  return { row, alreadyPosted: alreadyExisted };
}

// Reverses a ledger row by posting the exact negation of its deltas, linked
// back via reversal_of_id -- never edits or deletes the original, per the
// table's append-only convention. Idempotent the same way as
// postLedgerEntry: a repeated reversal request for the same original row
// computes the same operation_key and no-ops.
export async function reverseLedgerEntry(client, originalLedgerId, { reason, actorId = null } = {}) {
  const { rows } = await client.query("SELECT * FROM bonus_point_ledger WHERE id = $1", [originalLedgerId]);
  const original = rows[0];
  if (!original) throw new Error(`reverseLedgerEntry: no ledger row with id ${originalLedgerId}`);
  const { row, alreadyExisted } = await insertIdempotent(client, {
    insertSql: `INSERT INTO bonus_point_ledger (
         user_id, activity, collectible_delta_scaled, points_delta_scaled, rule_version_id,
         source_contribution_id, attendance_id, challenge_award_id, reversal_of_id, operation_key, reason, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
    insertParams: [
      original.user_id,
      original.activity,
      -original.collectible_delta_scaled,
      -original.points_delta_scaled,
      original.rule_version_id,
      original.source_contribution_id,
      original.attendance_id,
      original.challenge_award_id,
      originalLedgerId,
      `reversal:${originalLedgerId}`,
      reason ?? `Reversal of ledger entry ${originalLedgerId}`,
      actorId,
    ],
    conflictSelectSql: "SELECT * FROM bonus_point_ledger WHERE operation_key = $1",
    conflictSelectParams: [`reversal:${originalLedgerId}`],
  });
  return { row, alreadyPosted: alreadyExisted };
}
