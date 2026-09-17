// Badge awarding (bonus_badge_definitions/bonus_badge_awards --
// migrations/076_bonuses_schema.sql, seeded with the brief's 4 Release-1
// badges). Gamification-only, no cash/points effect -- unlike a watermelon
// challenge award, awarding a badge never touches bonus_point_ledger.
//
// Idempotency IS the "is this the first one" check: rather than scanning
// history to decide whether an event is a user's first, every award*()
// function here just attempts the insert on every occurrence of the
// triggering event, keyed by a deterministic per-user operation_key
// (`badge:<code>:<userId>`, globally unique per user regardless of which
// order/payment/claim/round triggered it). The database's own
// UNIQUE(operation_key) constraint on bonus_badge_awards is what makes only
// the very first occurrence actually insert a row -- every later occurrence
// hits the same key and no-ops, exactly the "first X" semantics these
// badges need, with no separate history scan to get wrong.
import { pool } from "./db/pool.js";
import { insertIdempotent } from "./bonusIdempotency.js";

// Called as a followup after the triggering event's own transaction has
// already committed (an order delivery, a payment ingest, a claim
// approval, a round finalization) -- never nested inside it, so a badge
// award can never roll back the underlying ledger/claim change it's
// reacting to. insertIdempotent's SAVEPOINT wrapping needs a single
// connection with an active transaction (not the bare pool, which may hand
// out a different connection per query), so this opens its own short-lived
// one.
async function awardBadge(code, userId, { sourceTable = null, sourceId = null } = {}) {
  const operationKey = `badge:${code}:${userId}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { row, alreadyExisted } = await insertIdempotent(client, {
      insertSql: `INSERT INTO bonus_badge_awards (badge_code, user_id, source_table, source_id, operation_key)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      insertParams: [code, userId, sourceTable, sourceId, operationKey],
      conflictSelectSql: "SELECT * FROM bonus_badge_awards WHERE operation_key = $1",
      conflictSelectParams: [operationKey],
    });
    await client.query("COMMIT");
    return { badge: row, alreadyExisted };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export const awardFirstDeliveredOrderBadge = (userId, orderId) =>
  awardBadge("first_delivered_order", userId, { sourceTable: "order", sourceId: orderId });

export const awardFirstAcceptedCollectionBadge = (userId, paymentId) =>
  awardBadge("first_accepted_collection", userId, { sourceTable: "payment", sourceId: paymentId });

export const awardFirstApprovedRewardBadge = (userId, claimId) =>
  awardBadge("first_approved_reward", userId, { sourceTable: "bonus_reward_claims", sourceId: claimId });

export const awardFirstBalancedBasketBadge = (userId, roundId) =>
  awardBadge("first_balanced_basket", userId, { sourceTable: "bonus_challenge_rounds", sourceId: roundId });

export async function listBadgesForUser(userId) {
  const { rows } = await pool.query(
    `SELECT d.code, d.title_key, d.description_key, a.issued_at
     FROM bonus_badge_awards a
     JOIN bonus_badge_definitions d ON d.code = a.badge_code
     WHERE a.user_id = $1 AND a.status = 'issued'
     ORDER BY a.issued_at ASC`,
    [userId]
  );
  return rows;
}
