// Real-Postgres coverage for the Phase 5 reward-claim accounting module:
// claim creation at round finalization, the approve/reject/hold/pay state
// machine, self-approval/self-payment blocks, optimistic-lock conflicts,
// and amount adjustment.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import { createDraftTemplate, publishTemplate } from "../../src/bonusChallengeTemplates.js";
import { ensureOnceRound } from "../../src/bonusChallengeRounds.js";
import { processRound } from "../../src/bonusChallengeWorker.js";
import { setBonusesEnabled } from "../../src/bonusSettings.js";
import { getClaim, listClaims, approveClaim, rejectClaim, holdClaim, recordPayout, adjustClaimAmount, ClaimConflictError } from "../../src/bonusRewardClaims.js";
import { createUser, cleanupAll } from "./helpers.js";

const userIds = [];
const templateIds = [];

async function cleanupBonusRows() {
  if (templateIds.length) {
    const { rows: roundRows } = await pool.query("SELECT id FROM bonus_challenge_rounds WHERE template_id = ANY($1)", [templateIds]);
    const roundIds = roundRows.map((r) => r.id);
    if (roundIds.length) {
      await pool.query("DELETE FROM bonus_audit_log WHERE entity_table = 'bonus_reward_claims' AND entity_id IN (SELECT id FROM bonus_reward_claims WHERE round_id = ANY($1))", [
        roundIds,
      ]);
      await pool.query("DELETE FROM bonus_reward_claims WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_point_ledger WHERE challenge_award_id IN (SELECT id FROM bonus_challenge_awards WHERE round_id = ANY($1))", [
        roundIds,
      ]);
      await pool.query("DELETE FROM bonus_challenge_awards WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_progress WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_round_participants WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_challenge_rounds WHERE id = ANY($1)", [roundIds]);
    }
    await pool.query("DELETE FROM bonus_challenge_template_targets WHERE template_id = ANY($1)", [templateIds]);
    await pool.query("DELETE FROM bonus_challenge_templates WHERE id = ANY($1)", [templateIds]);
  }
  if (userIds.length) {
    await pool.query("DELETE FROM bonus_point_ledger WHERE user_id = ANY($1)", [userIds]);
    await pool.query("DELETE FROM bonus_attendance_records WHERE user_id = ANY($1)", [userIds]);
  }
}

test.after(async () => {
  await setBonusesEnabled(false);
  await cleanupBonusRows();
  await cleanupAll();
});

// Builds a finalized round with one participant who reached target and has
// a claim waiting for review -- the fixture every test below starts from.
async function seedAwaitingClaim({ rewardAmd = 10000 } = {}) {
  await setBonusesEnabled(true);
  const admin = await createUser("admin");
  userIds.push(admin.id);
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const template = await publishTemplate(
    (
      await createDraftTemplate(
        {
          title: `claim fixture ${Date.now()}`,
          type: "single_metric",
          audienceMode: "selected_users",
          audienceUserIds: [manager.id],
          recurrence: "once",
          firstRoundPolicy: "historical_explicit",
          customStartDate: "2020-01-01",
          customEndDate: "2020-01-01",
          validationGraceDays: 1,
          rewardAmd,
          targets: [{ metric: "strawberry", targetScaled: 2 }],
        },
        admin.id
      )
    ).id,
    admin.id
  );
  templateIds.push(template.id);
  const { round } = await ensureOnceRound(template, new Date("2020-01-01T12:00:00Z"));

  const { rows: attendanceRows } = await pool.query(
    `INSERT INTO bonus_attendance_records (user_id, local_date, occurrence_at, qualifies) VALUES ($1, '2020-01-01', '2020-01-01T12:00:00Z', true) RETURNING id`,
    [manager.id]
  );
  await pool.query(
    `INSERT INTO bonus_point_ledger (user_id, activity, collectible_delta_scaled, points_delta_scaled, attendance_id, operation_key, created_at)
     VALUES ($1, 'strawberry', 2, 2, $2, $3, '2020-01-01T12:30:00Z')`,
    [manager.id, attendanceRows[0].id, `test:${round.id}:claimfixture`]
  );

  await processRound(round, new Date());
  const claims = await listClaims({ userId: manager.id });
  await setBonusesEnabled(false);
  return { admin, manager, round, claim: claims[0] };
}

test("createClaimsForFinalizedRound: a finalized round with a reward creates exactly one claim per participant who reached target", async () => {
  const { manager, claim } = await seedAwaitingClaim({ rewardAmd: 5000 });
  assert.ok(claim);
  assert.equal(claim.status, "awaiting_validation");
  assert.equal(claim.amount_amd, 5000);
  assert.equal(claim.user_id, manager.id);
});

test("approveClaim: an accountant can approve; the same user cannot approve their own claim", async () => {
  const { manager, claim } = await seedAwaitingClaim();
  const accountant = await createUser("accountant");
  userIds.push(accountant.id);

  // Simulates the claim's own recipient also holding an approving role
  // (e.g. an admin who is also a challenge participant) -- the self-block
  // must fire even then, so this passes an approving role with the
  // recipient's own id, not a non-approving role (which would fail the
  // role check first and never reach the self-check).
  await assert.rejects(() => approveClaim(claim.id, "accountant", manager.id, claim.version), /own reward claim/);

  const approved = await approveClaim(claim.id, "accountant", accountant.id, claim.version);
  assert.equal(approved.status, "approved");
  assert.equal(approved.approved_by, accountant.id);
  assert.equal(approved.version, claim.version + 1);
});

test("approveClaim: a sales_manager (not canApproveBonusRewards) is rejected", async () => {
  const { claim } = await seedAwaitingClaim();
  const otherManager = await createUser("sales_manager");
  userIds.push(otherManager.id);
  await assert.rejects(() => approveClaim(claim.id, "sales_manager", otherManager.id, claim.version), /Not allowed/);
});

test("approveClaim: a stale expected_version is a conflict, not a silent overwrite", async () => {
  const { claim } = await seedAwaitingClaim();
  const accountant = await createUser("accountant");
  userIds.push(accountant.id);
  await assert.rejects(() => approveClaim(claim.id, "accountant", accountant.id, claim.version + 99), ClaimConflictError);
});

test("recordPayout: requires 'approved' status; accountant can record it; the recipient cannot pay themselves", async () => {
  const { manager, claim } = await seedAwaitingClaim();
  const accountant = await createUser("accountant");
  userIds.push(accountant.id);

  await assert.rejects(() => recordPayout(claim.id, "accountant", accountant.id, "REF-1", claim.version), /must be approved/);

  const approved = await approveClaim(claim.id, "accountant", accountant.id, claim.version);
  await assert.rejects(() => recordPayout(claim.id, "accountant", manager.id, "REF-1", approved.version), /own reward payout/);

  const paid = await recordPayout(claim.id, "accountant", accountant.id, "REF-1", approved.version);
  assert.equal(paid.status, "paid");
  assert.equal(paid.payment_reference, "REF-1");
  assert.equal(paid.paid_by, accountant.id);
});

test("rejectClaim + holdClaim: both require a reviewing role and record a reason", async () => {
  const seeded1 = await seedAwaitingClaim();
  const ceo = await createUser("ceo");
  userIds.push(ceo.id);
  const rejected = await rejectClaim(seeded1.claim.id, "ceo", ceo.id, "duplicate award", seeded1.claim.version);
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.rejection_reason, "duplicate award");

  const seeded2 = await seedAwaitingClaim();
  const held = await holdClaim(seeded2.claim.id, "ceo", ceo.id, "verifying evidence", seeded2.claim.version);
  assert.equal(held.status, "on_hold");
  assert.equal(held.hold_reason, "verifying evidence");
  // A held claim can still be approved afterward.
  const approvedAfterHold = await approveClaim(seeded2.claim.id, "ceo", ceo.id, held.version);
  assert.equal(approvedAfterHold.status, "approved");
});

test("adjustClaimAmount: changes the amount before review and is rejected once approved", async () => {
  const { claim } = await seedAwaitingClaim({ rewardAmd: 10000 });
  const ceo = await createUser("ceo");
  userIds.push(ceo.id);

  const adjusted = await adjustClaimAmount(claim.id, "ceo", ceo.id, 8000, "corrected tier", claim.version);
  assert.equal(adjusted.amount_amd, 8000);

  const approved = await approveClaim(claim.id, "ceo", ceo.id, adjusted.version);
  await assert.rejects(() => adjustClaimAmount(claim.id, "ceo", ceo.id, 1, "too late", approved.version), /must be awaiting_validation or on_hold/);

  const { rows: auditRows } = await pool.query(
    "SELECT action, before, after FROM bonus_audit_log WHERE entity_table = 'bonus_reward_claims' AND entity_id = $1 ORDER BY id",
    [claim.id]
  );
  assert.equal(auditRows[0].action, "adjust_amount");
  assert.equal(auditRows[0].before.amount_amd, 10000);
  assert.equal(auditRows[0].after.amount_amd, 8000);
});

test("createClaimsForFinalizedRound: a round with no configured reward creates no claims", async () => {
  await setBonusesEnabled(true);
  const admin = await createUser("admin");
  userIds.push(admin.id);
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const template = await publishTemplate(
    (
      await createDraftTemplate(
        {
          title: `no reward ${Date.now()}`,
          type: "single_metric",
          audienceMode: "selected_users",
          audienceUserIds: [manager.id],
          recurrence: "once",
          firstRoundPolicy: "historical_explicit",
          customStartDate: "2020-02-01",
          customEndDate: "2020-02-01",
          validationGraceDays: 1,
          targets: [{ metric: "strawberry", targetScaled: 2 }],
        },
        admin.id
      )
    ).id,
    admin.id
  );
  templateIds.push(template.id);
  const { round } = await ensureOnceRound(template, new Date("2020-02-01T12:00:00Z"));
  await processRound(round, new Date());
  const claims = await listClaims({ userId: manager.id });
  await setBonusesEnabled(false);
  assert.equal(claims.length, 0);
});
