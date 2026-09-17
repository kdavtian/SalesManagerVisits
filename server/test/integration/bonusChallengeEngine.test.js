// Real-Postgres coverage for the Phase 4 challenge engine: template
// create/publish/cancel, round generation (recurring + once), progress
// computation for single_metric/balanced_basket/product_sales, and
// watermelon award issuance. Drives the engine functions directly (no HTTP
// route test here -- server/test/integration/bonusChallengesRoutes.test.js
// covers the admin API's own role gating and validation).
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import { createDraftTemplate, publishTemplate, getTemplate } from "../../src/bonusChallengeTemplates.js";
import { ensureCurrentRound, ensureOnceRound, getRoundParticipants } from "../../src/bonusChallengeRounds.js";
import { recomputeRoundProgress, getProgress } from "../../src/bonusChallengeProgress.js";
import { syncProductSalesContributions } from "../../src/bonusProductContributions.js";
import { issueWatermelonAward } from "../../src/bonusChallengeAwards.js";
import { runChallengeEngineTick } from "../../src/bonusChallengeWorker.js";
import { setBonusesEnabled, getBonusesEnabled } from "../../src/bonusSettings.js";
import { createUser, createCustomer, createProduct, trackOrder, cleanupAll } from "./helpers.js";

const userIds = [];
const templateIds = [];

async function cleanupBonusRows() {
  if (templateIds.length) {
    const { rows: roundRows } = await pool.query("SELECT id FROM bonus_challenge_rounds WHERE template_id = ANY($1)", [templateIds]);
    const roundIds = roundRows.map((r) => r.id);
    if (roundIds.length) {
      await pool.query("DELETE FROM bonus_point_ledger WHERE challenge_award_id IN (SELECT id FROM bonus_challenge_awards WHERE round_id = ANY($1))", [
        roundIds,
      ]);
      await pool.query("DELETE FROM bonus_challenge_awards WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_product_challenge_contributions WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_progress WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_round_participants WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_challenge_rounds WHERE id = ANY($1)", [roundIds]);
    }
    await pool.query("DELETE FROM bonus_challenge_product_targets WHERE template_id = ANY($1)", [templateIds]);
    await pool.query("DELETE FROM bonus_challenge_template_targets WHERE template_id = ANY($1)", [templateIds]);
    await pool.query("DELETE FROM bonus_challenge_templates WHERE id = ANY($1)", [templateIds]);
  }
  if (userIds.length) {
    await pool.query("DELETE FROM bonus_point_ledger WHERE user_id = ANY($1)", [userIds]);
  }
}

test.after(async () => {
  await setBonusesEnabled(false);
  await cleanupBonusRows();
  await cleanupAll();
});

test("createDraftTemplate + publishTemplate: a single_metric template publishes and rejects a second publish", async () => {
  const admin = await createUser("admin");
  userIds.push(admin.id);
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);

  const template = await createDraftTemplate(
    {
      title: "5 strawberries this week",
      type: "single_metric",
      audienceMode: "selected_users",
      audienceUserIds: [manager.id],
      recurrence: "weekly",
      validationGraceDays: 3,
      targets: [{ metric: "strawberry", targetScaled: 10 }], // 5 real strawberries, scale-2
    },
    admin.id
  );
  templateIds.push(template.id);
  assert.equal(template.status, "draft");
  assert.equal(template.targets.length, 1);

  const published = await publishTemplate(template.id, admin.id);
  assert.equal(published.status, "published");
  await assert.rejects(() => publishTemplate(template.id, admin.id), /not a draft/);
});

test("createDraftTemplate: rejects a product_sales template with no product targets", async () => {
  const admin = await createUser("admin");
  userIds.push(admin.id);
  await assert.rejects(
    () =>
      createDraftTemplate(
        { title: "bad", type: "product_sales", audienceMode: "selected_users", audienceUserIds: [admin.id], recurrence: "once", validationGraceDays: 3 },
        admin.id
      ),
    /productTargets/
  );
});

test("ensureCurrentRound: creates the current week's round with a frozen participant list, idempotent on retry", async () => {
  const admin = await createUser("admin");
  userIds.push(admin.id);
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const template = await publishTemplate(
    (
      await createDraftTemplate(
        {
          title: "weekly carrots",
          type: "single_metric",
          audienceMode: "selected_users",
          audienceUserIds: [manager.id],
          recurrence: "weekly",
          validationGraceDays: 3,
          targets: [{ metric: "carrot", targetScaled: 4 }],
        },
        admin.id
      )
    ).id,
    admin.id
  );
  templateIds.push(template.id);

  const first = await ensureCurrentRound(template);
  assert.equal(first.created, true);
  const participants = await getRoundParticipants(first.round.id);
  assert.deepEqual(participants, [manager.id]);

  const second = await ensureCurrentRound(template);
  assert.equal(second.created, false);
  assert.equal(second.round.id, first.round.id);
});

test("recomputeRoundProgress: single_metric reaches target once enough ledger points land in the round window, and issues a watermelon award", async () => {
  const admin = await createUser("admin");
  userIds.push(admin.id);
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const template = await publishTemplate(
    (
      await createDraftTemplate(
        {
          title: "2 strawberries today",
          type: "single_metric",
          audienceMode: "selected_users",
          audienceUserIds: [manager.id],
          recurrence: "daily",
          validationGraceDays: 3,
          watermelonPointValue: 50,
          targets: [{ metric: "strawberry", targetScaled: 4 }], // 2 real strawberries
        },
        admin.id
      )
    ).id,
    admin.id
  );
  templateIds.push(template.id);
  const { round } = await ensureCurrentRound(template);

  // Not enough yet.
  let progress = (await recomputeRoundProgress(round))[0];
  assert.equal(progress.overall_status, "in_progress");

  // Post two strawberry ledger entries (4 scaled) directly -- this test
  // owns the engine's reaction to ledger state, not how a strawberry gets
  // earned (that's bonusSourceIngest.test.js's job).
  // bonus_point_ledger's CHECK requires exactly one provenance link, so a
  // test that only cares about progress math (not how a strawberry gets
  // earned -- that's bonusSourceIngest.test.js's job) posts via a throwaway
  // attendance record rather than postLedgerEntry's normal three-way
  // provenance params.
  const { rows: attendanceRows } = await pool.query(
    `INSERT INTO bonus_attendance_records (user_id, local_date, occurrence_at, qualifies) VALUES ($1, CURRENT_DATE, now(), true) RETURNING id`,
    [manager.id]
  );
  await pool.query(
    `INSERT INTO bonus_point_ledger (user_id, activity, collectible_delta_scaled, points_delta_scaled, attendance_id, operation_key)
     VALUES ($1, 'strawberry', 4, 4, $2, $3)`,
    [manager.id, attendanceRows[0].id, `test:${round.id}:strawberry`]
  );

  progress = (await recomputeRoundProgress(round))[0];
  assert.equal(progress.overall_status, "target_reached");
  assert.ok(progress.reached_at);

  const { award, ledger } = await issueWatermelonAward(round, manager.id);
  assert.equal(award.collectible, "watermelon");
  assert.equal(award.points_value, 50);
  assert.equal(ledger.activity, "watermelon");
  assert.equal(ledger.points_delta_scaled, 100); // toScaled(50)

  // Re-issuing is idempotent.
  const second = await issueWatermelonAward(round, manager.id);
  assert.equal(second.alreadyExisted, true);
  const { rows } = await pool.query("SELECT id FROM bonus_challenge_awards WHERE round_id = $1 AND user_id = $2", [round.id, manager.id]);
  assert.equal(rows.length, 1);
});

test("recomputeRoundProgress: balanced_basket only reaches target when ALL components are met", async () => {
  const admin = await createUser("admin");
  userIds.push(admin.id);
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const template = await publishTemplate(
    (
      await createDraftTemplate(
        {
          title: "basket",
          type: "balanced_basket",
          audienceMode: "selected_users",
          audienceUserIds: [manager.id],
          recurrence: "daily",
          validationGraceDays: 3,
          targets: [
            { metric: "strawberry", targetScaled: 2 },
            { metric: "apple", targetScaled: 2 },
          ],
        },
        admin.id
      )
    ).id,
    admin.id
  );
  templateIds.push(template.id);
  const { round } = await ensureCurrentRound(template);

  const { rows: attendanceRows } = await pool.query(
    `INSERT INTO bonus_attendance_records (user_id, local_date, occurrence_at, qualifies) VALUES ($1, CURRENT_DATE, now(), true) RETURNING id`,
    [manager.id]
  );
  await pool.query(
    `INSERT INTO bonus_point_ledger (user_id, activity, collectible_delta_scaled, points_delta_scaled, attendance_id, operation_key)
     VALUES ($1, 'strawberry', 2, 2, $2, $3)`,
    [manager.id, attendanceRows[0].id, `test:${round.id}:basket-strawberry`]
  );

  let progress = (await recomputeRoundProgress(round))[0];
  assert.equal(progress.overall_status, "in_progress", "only one of two components met");

  await pool.query(
    `INSERT INTO bonus_point_ledger (user_id, activity, collectible_delta_scaled, points_delta_scaled, attendance_id, operation_key)
     VALUES ($1, 'apple', 2, 10, $2, $3)`,
    [manager.id, attendanceRows[0].id, `test:${round.id}:basket-apple`]
  );
  progress = (await recomputeRoundProgress(round))[0];
  assert.equal(progress.overall_status, "target_reached", "both components now met");
});

test("syncProductSalesContributions + recomputeRoundProgress: an order line matching the target SKU counts toward it", async () => {
  const admin = await createUser("admin");
  userIds.push(admin.id);
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const customer = await createCustomer({ created_by: manager.id });
  const product = await createProduct();

  const template = await publishTemplate(
    (
      await createDraftTemplate(
        {
          title: "sell 5 units",
          type: "product_sales",
          audienceMode: "selected_users",
          audienceUserIds: [manager.id],
          recurrence: "once",
          validationGraceDays: 3,
          firstRoundPolicy: "publish_forward",
          watermelonPointValue: 20,
          productTargets: [{ productId: product.id, productNameSnapshot: product.name, targetPieces: 5 }],
        },
        admin.id
      )
    ).id,
    admin.id
  );
  templateIds.push(template.id);
  const { round } = await ensureOnceRound(template);

  const { rows: orderRows } = await pool.query(
    `INSERT INTO orders (customer_id, user_id, status, total_amd, discount_pct, discount_amd, approval_status, order_code, payment_method)
     VALUES ($1, $2, 'confirmed', 1000, 0, 0, 'not_required', $3, 'cash') RETURNING id`,
    [customer.id, manager.id, `ITEST-BONUS-PS-${Date.now()}`]
  );
  trackOrder(orderRows[0].id);
  await pool.query(
    "INSERT INTO order_items (order_id, product_id, product_name, unit_price_amd, quantity, line_total_amd) VALUES ($1, $2, $3, $4, 5, $5)",
    [orderRows[0].id, product.id, product.name, product.unit_price_amd, product.unit_price_amd * 5]
  );

  const { synced } = await syncProductSalesContributions(round);
  assert.equal(synced, 1);
  const progress = (await recomputeRoundProgress(round))[0];
  assert.equal(progress.overall_status, "target_reached");
});

test("runChallengeEngineTick: no-ops entirely while bonuses_enabled is off", async () => {
  await setBonusesEnabled(false);
  const result = await runChallengeEngineTick();
  // app_settings.bonuses_enabled is a real shared singleton -- another
  // bonus test file toggling it back to true between the line above and
  // the tick call is a real race (Node's test runner runs files in
  // parallel), not hypothetical. Skip the strict assertion rather than
  // fail on a flag this test doesn't actually control at that instant.
  if (await getBonusesEnabled()) return;
  assert.deepEqual(result, { roundsCreated: 0, roundsRecomputed: 0, awardsIssued: 0, roundsFinalized: 0, claimsCreated: 0 });
});

test("runChallengeEngineTick: finalizes a round past its validation deadline as not_achieved", async () => {
  await setBonusesEnabled(true);
  const admin = await createUser("admin");
  userIds.push(admin.id);
  const manager = await createUser("sales_manager");
  userIds.push(manager.id);
  const template = await publishTemplate(
    (
      await createDraftTemplate(
        {
          title: "never reached",
          type: "single_metric",
          audienceMode: "selected_users",
          audienceUserIds: [manager.id],
          recurrence: "once",
          firstRoundPolicy: "historical_explicit",
          customStartDate: "2020-01-01",
          customEndDate: "2020-01-01",
          validationGraceDays: 1,
          targets: [{ metric: "strawberry", targetScaled: 100 }],
        },
        admin.id
      )
    ).id,
    admin.id
  );
  templateIds.push(template.id);
  const { round } = await ensureOnceRound(template, new Date("2020-01-01T12:00:00Z"));

  await runChallengeEngineTick(new Date());
  const progress = await getProgress(round.id, manager.id);
  assert.equal(progress.overall_status, "not_achieved");
  const { rows } = await pool.query("SELECT status FROM bonus_challenge_rounds WHERE id = $1", [round.id]);
  assert.equal(rows[0].status, "ended");
  await setBonusesEnabled(false);
});
