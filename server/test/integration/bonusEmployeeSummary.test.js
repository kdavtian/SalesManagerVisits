// Real-Postgres coverage for the Phase 6 employee summary aggregation
// (bonusEmployeeSummary.js): points/collectible totals, level lookup
// against the seeded thresholds, active-challenge listing, and claim
// history -- all scoped to one user, read-only.
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import { getBonusSummaryForUser } from "../../src/bonusEmployeeSummary.js";
import { createDraftTemplate, publishTemplate } from "../../src/bonusChallengeTemplates.js";
import { ensureCurrentRound } from "../../src/bonusChallengeRounds.js";
import { processRound } from "../../src/bonusChallengeWorker.js";
import { setBonusesEnabled } from "../../src/bonusSettings.js";
import { createUser, cleanupAll } from "./helpers.js";

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
    await pool.query("DELETE FROM bonus_point_ledger WHERE user_id = ANY($1)", [userIds]);
    await pool.query("DELETE FROM bonus_attendance_records WHERE user_id = ANY($1)", [userIds]);
  }
}

test.after(async () => {
  await setBonusesEnabled(false);
  await cleanupBonusRows();
  await cleanupAll();
});

test("getBonusSummaryForUser: sums points/collectibles and picks the right level from the seeded thresholds", async () => {
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);

  // Two whole strawberries (scaled 2 each) at the seeded 1 point/unit rate,
  // and one whole apple (scaled 2) at the seeded 5 points/unit rate --
  // total 2*1 + 5 = 7 real points, well below level 2's 100-point threshold.
  const { rows: attendanceRows } = await pool.query(
    `INSERT INTO bonus_attendance_records (user_id, local_date, occurrence_at, qualifies) VALUES ($1, CURRENT_DATE, now(), true) RETURNING id`,
    [manager.id]
  );
  await pool.query(
    `INSERT INTO bonus_point_ledger (user_id, activity, collectible_delta_scaled, points_delta_scaled, attendance_id, operation_key)
     VALUES ($1, 'strawberry', 2, 2, $2, 'summary-test-1'), ($1, 'strawberry', 2, 2, $2, 'summary-test-2'), ($1, 'apple', 2, 10, $2, 'summary-test-3')`,
    [manager.id, attendanceRows[0].id]
  );

  const summary = await getBonusSummaryForUser(manager.id);
  assert.equal(summary.pointsTotal, 7);
  assert.equal(summary.collectibleCounts.strawberry, 2);
  assert.equal(summary.collectibleCounts.apple, 1);
  assert.equal(summary.collectibleCounts.carrot, 0);
  assert.equal(summary.level.number, 1); // below the 100-point level-2 threshold
  assert.equal(summary.level.pointsToNextLevel, 93); // 100 - 7

  // The leaderboard is a company-wide ranking (other sales_manager fixtures
  // from parallel tests may also be on it), so only assert this manager's
  // own row -- it must agree with pointsTotal above, not drift into its own
  // separately-computed number.
  const ownRow = summary.pointsLeaderboard.find((p) => p.user_id === manager.id);
  assert.ok(ownRow, "the manager must appear on their own leaderboard");
  assert.equal(ownRow.total_points, 7);
  assert.equal(ownRow.user_name, manager.name);
});

test("getBonusSummaryForUser: lists an active challenge's progress and past claims", async () => {
  await setBonusesEnabled(true);
  const admin = await createUser("admin");
  userIds.push(admin.id);
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);

  const template = await publishTemplate(
    (
      await createDraftTemplate(
        {
          title: "summary test challenge",
          type: "single_metric",
          audienceMode: "selected_users",
          audienceUserIds: [manager.id],
          recurrence: "weekly",
          validationGraceDays: 3,
          targets: [{ metric: "strawberry", targetScaled: 10 }],
        },
        admin.id
      )
    ).id,
    admin.id
  );
  templateIds.push(template.id);
  const { round } = await ensureCurrentRound(template);
  await processRound(round, new Date());
  await setBonusesEnabled(false);

  const summary = await getBonusSummaryForUser(manager.id);
  assert.equal(summary.activeChallenges.length, 1);
  assert.equal(summary.activeChallenges[0].round_id, round.id);
  assert.equal(summary.activeChallenges[0].title, "summary test challenge");
  assert.equal(summary.activeChallenges[0].overall_status, "in_progress");
  assert.deepEqual(summary.claims, []); // no reward configured, no claim created
});
