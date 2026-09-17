// Reward claim accounting (bonus_reward_claims -- migrations/076_bonuses_schema.sql).
// Deliberately separate from bonus_progress (the brief: "Keep progress state
// separate from the claim/payment record") -- a claim is only ever created
// once, at round finalization, from whatever bonus_progress says at that
// moment; nothing here ever recomputes progress itself.
//
// Every mutation uses the same optimistic-lock pattern as
// routes/teamPerformance.js's perf_plans.lock_version (SELECT ... FOR
// UPDATE, compare against an expectedVersion the caller already has,
// 409-equivalent on mismatch) -- "transactional locking" per the brief,
// guarding against two admins approving/paying the same claim at once.
import { pool } from "./db/pool.js";
import { canApproveBonusRewards, canRecordBonusPayouts } from "./roles.js";

const AWAITING = "awaiting_validation";

class ClaimConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaimConflictError";
    this.code = "CLAIM_CONFLICT";
  }
}

// Creates one claim per participant whose final progress reached target on
// a round with a configured cash reward -- called by bonusChallengeWorker.js
// exactly once, right when a round is finalized (validation_deadline_at
// passed), never earlier: the grace period exists precisely so a
// late-arriving contribution isn't wrongly denied, and a claim created
// before finalization would lock in a possibly-premature amount.
// UNIQUE(round_id, user_id) makes a repeat call idempotent.
export async function createClaimsForFinalizedRound(round) {
  const rewardAmd = round.snapshot_rules.rewardAmd;
  if (!rewardAmd) return { created: 0 };

  const { rows: reachedRows } = await pool.query(
    "SELECT user_id FROM bonus_progress WHERE round_id = $1 AND overall_status = 'target_reached'",
    [round.id]
  );
  let created = 0;
  for (const { user_id: userId } of reachedRows) {
    const { rowCount } = await pool.query(
      `INSERT INTO bonus_reward_claims (round_id, user_id, amount_amd) VALUES ($1, $2, $3)
       ON CONFLICT (round_id, user_id) DO NOTHING`,
      [round.id, userId, rewardAmd]
    );
    if (rowCount) created += 1;
  }
  return { created };
}

export async function getClaim(id) {
  const { rows } = await pool.query("SELECT * FROM bonus_reward_claims WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listClaims({ status, userId } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  if (userId) {
    params.push(userId);
    clauses.push(`user_id = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { rows } = await pool.query(`SELECT * FROM bonus_reward_claims ${where} ORDER BY created_at DESC`, params);
  return rows;
}

// Locks the claim row, checks the caller's expected version against its
// current one, runs `mutate` (which must produce the next status/columns),
// writes an audit log row, and returns the updated claim. `mutate` receives
// the locked row and must throw to abort (caught by the caller of this
// function, which rolls back).
async function withClaimLock(claimId, expectedVersion, action, actorId, mutate) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM bonus_reward_claims WHERE id = $1 FOR UPDATE", [claimId]);
    const claim = rows[0];
    if (!claim) throw new Error(`Claim ${claimId} not found`);
    if (expectedVersion !== undefined && claim.version !== expectedVersion) {
      throw new ClaimConflictError("This claim was changed by someone else. Reload and try again.");
    }

    const { setSql, setParams, before, after } = mutate(claim);
    const { rows: updatedRows } = await client.query(
      `UPDATE bonus_reward_claims SET ${setSql}, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [claimId, ...setParams]
    );
    const updated = updatedRows[0];

    await client.query(
      `INSERT INTO bonus_audit_log (actor_id, action, entity_table, entity_id, before, after)
       VALUES ($1, $2, 'bonus_reward_claims', $3, $4, $5)`,
      [actorId ?? null, action, claimId, JSON.stringify(before), JSON.stringify(after)]
    );

    await client.query("COMMIT");
    return updated;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function requireStatus(claim, allowed, verb) {
  if (!allowed.includes(claim.status)) {
    throw new Error(`Cannot ${verb} a claim in status '${claim.status}' (must be ${allowed.join(" or ")})`);
  }
}

// Self-approval block (the brief's explicit requirement): the person
// approving/rejecting/holding a claim can never be its recipient, even if
// they otherwise hold an approving role (e.g. an admin who is also the
// challenge's participant).
export async function approveClaim(claimId, actorRole, actorId, expectedVersion) {
  if (!canApproveBonusRewards(actorRole)) throw new Error("Not allowed to approve reward claims");
  return withClaimLock(claimId, expectedVersion, "approve", actorId, (claim) => {
    if (claim.user_id === actorId) throw new Error("Cannot approve your own reward claim");
    requireStatus(claim, [AWAITING, "on_hold"], "approve");
    return {
      setSql: "status = 'approved', approved_by = $2, approved_at = now(), rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL, hold_reason = NULL",
      setParams: [actorId],
      before: { status: claim.status },
      after: { status: "approved" },
    };
  });
}

export async function rejectClaim(claimId, actorRole, actorId, reason, expectedVersion) {
  if (!canApproveBonusRewards(actorRole)) throw new Error("Not allowed to reject reward claims");
  return withClaimLock(claimId, expectedVersion, "reject", actorId, (claim) => {
    if (claim.user_id === actorId) throw new Error("Cannot reject your own reward claim");
    requireStatus(claim, [AWAITING, "on_hold"], "reject");
    return {
      setSql: "status = 'rejected', rejected_by = $2, rejected_at = now(), rejection_reason = $3, hold_reason = NULL",
      setParams: [actorId, reason ?? null],
      before: { status: claim.status },
      after: { status: "rejected", reason: reason ?? null },
    };
  });
}

export async function holdClaim(claimId, actorRole, actorId, reason, expectedVersion) {
  if (!canApproveBonusRewards(actorRole)) throw new Error("Not allowed to hold reward claims");
  return withClaimLock(claimId, expectedVersion, "hold", actorId, (claim) => {
    requireStatus(claim, [AWAITING, "approved"], "hold");
    return {
      setSql: "status = 'on_hold', hold_reason = $2",
      setParams: [reason ?? null],
      before: { status: claim.status },
      after: { status: "on_hold", reason: reason ?? null },
    };
  });
}

// Payout recording -- separate role from approval (canRecordBonusPayouts:
// accountant/admin, mirroring canRecordOrders), and a separate self-payment
// block: the person recording a payout can never be its recipient either.
export async function recordPayout(claimId, actorRole, actorId, paymentReference, expectedVersion) {
  if (!canRecordBonusPayouts(actorRole)) throw new Error("Not allowed to record reward payouts");
  return withClaimLock(claimId, expectedVersion, "pay", actorId, (claim) => {
    if (claim.user_id === actorId) throw new Error("Cannot record your own reward payout");
    requireStatus(claim, ["approved"], "pay");
    return {
      setSql: "status = 'paid', paid_by = $2, paid_at = now(), payment_reference = $3",
      setParams: [actorId, paymentReference ?? null],
      before: { status: claim.status },
      after: { status: "paid", payment_reference: paymentReference ?? null },
    };
  });
}

// Amount correction -- only before a claim leaves review (awaiting_validation
// or on_hold), never on an approved/paid claim (that's a payout dispute, not
// a claim-accounting adjustment, and out of this module's scope).
export async function adjustClaimAmount(claimId, actorRole, actorId, newAmountAmd, reason, expectedVersion) {
  if (!canApproveBonusRewards(actorRole)) throw new Error("Not allowed to adjust reward claims");
  if (!Number.isInteger(newAmountAmd) || newAmountAmd <= 0) throw new Error("newAmountAmd must be a positive integer");
  return withClaimLock(claimId, expectedVersion, "adjust_amount", actorId, (claim) => {
    requireStatus(claim, [AWAITING, "on_hold"], "adjust");
    return {
      setSql: "amount_amd = $2",
      setParams: [newAmountAmd],
      before: { amount_amd: claim.amount_amd },
      after: { amount_amd: newAmountAmd, reason: reason ?? null },
    };
  });
}

export { ClaimConflictError };
