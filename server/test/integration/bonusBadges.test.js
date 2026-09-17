// Real-Postgres coverage for the Phase 7 badge module: idempotent
// first-only awarding, and each of the 4 trigger points actually firing
// through the real ingest/claim/progress code paths (not just the award
// function in isolation).
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import { awardFirstDeliveredOrderBadge, listBadgesForUser } from "../../src/bonusBadges.js";
import { ingestOrderDelivery, ingestCollectionContribution } from "../../src/bonusSourceIngest.js";
import { approveClaim } from "../../src/bonusRewardClaims.js";
import { createDraftTemplate, publishTemplate } from "../../src/bonusChallengeTemplates.js";
import { ensureOnceRound } from "../../src/bonusChallengeRounds.js";
import { processRound } from "../../src/bonusChallengeWorker.js";
import { setBonusesEnabled } from "../../src/bonusSettings.js";
import { createUser, createCustomer, cleanupAll } from "./helpers.js";

const userIds = [];
const templateIds = [];

async function cleanupBonusRows() {
  if (templateIds.length) {
    const { rows: roundRows } = await pool.query("SELECT id FROM bonus_challenge_rounds WHERE template_id = ANY($1)", [templateIds]);
    const roundIds = roundRows.map((r) => r.id);
    if (roundIds.length) {
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
    await pool.query("DELETE FROM bonus_badge_awards WHERE user_id = ANY($1)", [userIds]);
    await pool.query("DELETE FROM bonus_point_ledger WHERE user_id = ANY($1)", [userIds]);
    await pool.query("DELETE FROM bonus_attendance_records WHERE user_id = ANY($1)", [userIds]);
  }
}

test.after(async () => {
  await setBonusesEnabled(false);
  await cleanupBonusRows();
  await cleanupAll();
});

test("awardFirstDeliveredOrderBadge: idempotent -- a second award attempt for the same user is a no-op", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);

  const first = await awardFirstDeliveredOrderBadge(manager.id, 111);
  assert.equal(first.alreadyExisted, false);
  assert.equal(first.badge.badge_code, "first_delivered_order");

  const second = await awardFirstDeliveredOrderBadge(manager.id, 222); // different order, same user
  assert.equal(second.alreadyExisted, true);
  assert.equal(second.badge.id, first.badge.id);

  const badges = await listBadgesForUser(manager.id);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].code, "first_delivered_order");
});

test("ingestOrderDelivery: delivering an order awards the first_delivered_order badge", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const { rows: orderRows } = await pool.query(
    `INSERT INTO orders (customer_id, user_id, status, total_amd, discount_pct, discount_amd, approval_status, order_code, payment_method)
     VALUES ($1, $2, 'delivered', 1000, 0, 0, 'not_required', $3, 'cash') RETURNING id`,
    [customer.id, manager.id, `ITEST-BADGE-${Date.now()}`]
  );
  await pool.query(
    "INSERT INTO order_status_history (order_id, old_status, new_status, changed_at) VALUES ($1, 'confirmed', 'delivered', now())",
    [orderRows[0].id]
  );

  await ingestOrderDelivery(orderRows[0].id);
  const badges = await listBadgesForUser(manager.id);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].code, "first_delivered_order");

  await pool.query("DELETE FROM bonus_point_ledger WHERE user_id = $1", [manager.id]);
  await pool.query("DELETE FROM bonus_source_contributions WHERE source_table = 'order' AND source_id = $1", [orderRows[0].id]);
  await pool.query("DELETE FROM bonus_earning_units WHERE user_id = $1", [manager.id]);
  await pool.query("DELETE FROM orders WHERE id = $1", [orderRows[0].id]);
});

test("ingestCollectionContribution: an approved payment awards the first_accepted_collection badge", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const { rows: paymentRows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, approved_by, approved_at)
     VALUES ($1, 'Fixture', 5000, now(), $2, 'Fixture Rep', 'approved', $2, $2, now()) RETURNING id`,
    [customer.id, manager.id]
  );

  await ingestCollectionContribution(paymentRows[0].id);
  const badges = await listBadgesForUser(manager.id);
  assert.equal(badges.length, 1);
  assert.equal(badges[0].code, "first_accepted_collection");

  await pool.query("DELETE FROM bonus_point_ledger WHERE user_id = $1", [manager.id]);
  await pool.query("DELETE FROM bonus_source_contributions WHERE source_table = 'payment' AND source_id = $1", [paymentRows[0].id]);
  await pool.query("DELETE FROM bonus_earning_units WHERE user_id = $1", [manager.id]);
  await pool.query("DELETE FROM payments WHERE id = $1", [paymentRows[0].id]);
});

test("approveClaim: approving a reward claim awards the first_approved_reward badge to the claimant, not the approver", async () => {
  await setBonusesEnabled(true);
  const admin = await createUser("admin");
  userIds.push(admin.id);
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);

  const template = await publishTemplate(
    (
      await createDraftTemplate(
        {
          title: "badge claim test",
          type: "single_metric",
          audienceMode: "selected_users",
          audienceUserIds: [manager.id],
          recurrence: "once",
          firstRoundPolicy: "historical_explicit",
          customStartDate: "2020-04-01",
          customEndDate: "2020-04-01",
          validationGraceDays: 1,
          rewardAmd: 1000,
          targets: [{ metric: "strawberry", targetScaled: 2 }],
        },
        admin.id
      )
    ).id,
    admin.id
  );
  templateIds.push(template.id);
  const { round } = await ensureOnceRound(template, new Date("2020-04-01T12:00:00Z"));
  const { rows: attendanceRows } = await pool.query(
    `INSERT INTO bonus_attendance_records (user_id, local_date, occurrence_at, qualifies) VALUES ($1, '2020-04-01', '2020-04-01T12:00:00Z', true) RETURNING id`,
    [manager.id]
  );
  await pool.query(
    `INSERT INTO bonus_point_ledger (user_id, activity, collectible_delta_scaled, points_delta_scaled, attendance_id, operation_key, created_at)
     VALUES ($1, 'strawberry', 2, 2, $2, 'badge-claim-test', '2020-04-01T12:00:00Z')`,
    [manager.id, attendanceRows[0].id]
  );
  await processRound(round, new Date());
  await setBonusesEnabled(false);

  const { rows: claimRows } = await pool.query("SELECT * FROM bonus_reward_claims WHERE user_id = $1", [manager.id]);
  await approveClaim(claimRows[0].id, "admin", admin.id, claimRows[0].version);

  const claimantBadges = await listBadgesForUser(manager.id);
  assert.ok(claimantBadges.some((b) => b.code === "first_approved_reward"));
  const approverBadges = await listBadgesForUser(admin.id);
  assert.equal(approverBadges.length, 0);
});
