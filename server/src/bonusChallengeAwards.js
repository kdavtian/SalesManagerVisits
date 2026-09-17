// Issues the watermelon collectible award (bonus_challenge_awards --
// migrations/076_bonuses_schema.sql) when a participant's progress reaches
// target, plus the corresponding bonus_point_ledger entry linked via
// challenge_award_id. Explicitly NOT the cash reward claim -- that's
// bonus_reward_claims, a separate table this module never touches (reward
// accounting/approval is Phase 5's scope per docs/bonuses-design.md).
//
// A template's watermelon_point_value is optional except for product_sales
// (enforced by the template's own CHECK constraint at publish time) -- a
// round whose snapshot_rules.watermelonPointValue is null issues no
// watermelon award at all, since there's nothing configured to award.
import { pool } from "./db/pool.js";
import { toScaled } from "./bonusUnits.js";
import { insertIdempotent } from "./bonusIdempotency.js";
import { postLedgerEntry } from "./bonusLedger.js";

export async function issueWatermelonAward(round, userId) {
  const watermelonPointValue = round.snapshot_rules.watermelonPointValue;
  if (!watermelonPointValue) return { award: null, ledger: null, reason: "no_watermelon_value_configured" };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const operationKey = `challenge:${round.id}:${userId}:watermelon`;
    const { row: award, alreadyExisted } = await insertIdempotent(client, {
      insertSql: `INSERT INTO bonus_challenge_awards (round_id, user_id, collectible, points_value, operation_key)
         VALUES ($1, $2, 'watermelon', $3, $4) RETURNING *`,
      insertParams: [round.id, userId, watermelonPointValue, operationKey],
      conflictSelectSql: "SELECT * FROM bonus_challenge_awards WHERE round_id = $1 AND user_id = $2",
      conflictSelectParams: [round.id, userId],
    });

    let ledger = null;
    if (!alreadyExisted) {
      ({ row: ledger } = await postLedgerEntry(client, {
        userId,
        activity: "watermelon",
        collectibleDeltaScaled: toScaled(1),
        pointsDeltaScaled: toScaled(watermelonPointValue),
        challengeAwardId: award.id,
        operationKey: `challenge_award:${award.id}`,
      }));
    }
    await client.query("COMMIT");
    return { award, ledger, alreadyExisted };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
