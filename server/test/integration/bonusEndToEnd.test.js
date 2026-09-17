// Phase 8 (docs/bonuses-design.md): end-to-end validation of the whole
// Bonuses module as a single user journey through the real HTTP routes and
// the real challenge-engine worker tick -- not another unit test for a
// single function, but proof that every phase's piece (source ingest,
// ledger, levels, challenge engine, badges, personal bests, reward claims,
// payouts, and the employee/admin route surfaces) still fits together
// correctly end to end now that all 7 build phases are merged.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { createDraftTemplate, publishTemplate } from "../../src/bonusChallengeTemplates.js";
import { ensureOnceRound } from "../../src/bonusChallengeRounds.js";
import { processRound } from "../../src/bonusChallengeWorker.js";
import { ingestCollectionContribution } from "../../src/bonusSourceIngest.js";
import { updatePersonalBestsForWeek } from "../../src/bonusPersonalBests.js";
import { yerevanWeekBounds } from "../../src/utils/yerevanDate.js";
import { getBonusesEnabled, setBonusesEnabled } from "../../src/bonusSettings.js";

let admin;
let accountant;
let manager;
let cookies;
let templateId;
let paymentId;

test.after(async () => {
  await setBonusesEnabled(false);
  if (templateId) {
    const { rows: roundRows } = await pool.query("SELECT id FROM bonus_challenge_rounds WHERE template_id = $1", [templateId]);
    const roundIds = roundRows.map((r) => r.id);
    if (roundIds.length) {
      await pool.query("DELETE FROM bonus_reward_claims WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_progress WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_round_participants WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_challenge_rounds WHERE id = ANY($1)", [roundIds]);
    }
    await pool.query("DELETE FROM bonus_challenge_template_targets WHERE template_id = $1", [templateId]);
    await pool.query("DELETE FROM bonus_challenge_templates WHERE id = $1", [templateId]);
  }
  if (manager) {
    await pool.query("DELETE FROM bonus_badge_awards WHERE user_id = $1", [manager.id]);
    await pool.query("DELETE FROM bonus_personal_bests WHERE user_id = $1", [manager.id]);
    await pool.query("DELETE FROM bonus_point_ledger WHERE user_id = $1", [manager.id]);
    await pool.query("DELETE FROM bonus_source_contributions WHERE source_table = 'payment' AND source_id = $1", [paymentId]);
    await pool.query("DELETE FROM bonus_earning_units WHERE user_id = $1", [manager.id]);
  }
  if (paymentId) await pool.query("DELETE FROM payments WHERE id = $1", [paymentId]);
  await cleanupAll();
  await stopTestServer();
});

test("bonuses_enabled defaults to false in a fresh app_settings row", async () => {
  const { rows } = await pool.query(
    "SELECT column_default FROM information_schema.columns WHERE table_name = 'app_settings' AND column_name = 'bonuses_enabled'"
  );
  assert.match(rows[0].column_default, /false/i);
});

test("full journey: disabled -> ingest -> challenge round -> badge -> claim -> approval -> payout -> re-disabled, all via real HTTP routes", async () => {
  await startTestServer();
  admin = await createUser("admin");
  accountant = await createUser("accountant");
  manager = await createUser("sales_manager");
  cookies = {
    admin: await loginAs(admin.email),
    accountant: await loginAs(accountant.email),
    manager: await loginAs(manager.email),
  };

  // 1. While disabled, the employee-facing summary route is genuinely
  //    unreachable (404, not an empty 200) -- the module must stay inert
  //    by default in every environment, including this test's own starting
  //    state.
  await setBonusesEnabled(false);
  assert.equal(await getBonusesEnabled(), false);
  const disabledSummary = await apiRequest("/api/bonus-summary", { cookie: cookies.manager });
  assert.equal(disabledSummary.status, 404);

  await setBonusesEnabled(true);

  // 2. Admin designs and publishes a challenge template over the real
  //    admin HTTP routes (Phase 4).
  const createRes = await apiRequest("/api/bonus-challenges/templates", {
    method: "POST",
    cookie: cookies.admin,
    body: {
      title: "e2e validation challenge",
      type: "single_metric",
      audienceMode: "selected_users",
      audienceUserIds: [manager.id],
      recurrence: "once",
      firstRoundPolicy: "publish_forward",
      validationGraceDays: 1,
      rewardAmd: 7000,
      targets: [{ metric: "carrot", targetScaled: 1 }],
    },
  });
  assert.equal(createRes.status, 201);
  templateId = createRes.data.id;

  const publishRes = await apiRequest(`/api/bonus-challenges/templates/${templateId}/publish`, { method: "POST", cookie: cookies.admin });
  assert.equal(publishRes.status, 200);
  assert.equal(publishRes.data.status, "published");

  // Round creation is the challenge-engine worker's job (no HTTP endpoint
  // triggers it directly), same as every other Bonuses test -- calling it
  // here still exercises the real production code path, just without
  // waiting for the hourly setInterval. It needs a real DB row (Date
  // instances for the DATE columns), not the HTTP response's JSON-
  // serialized template -- exactly what the worker's own DB query hands
  // it in production. 'publish_forward' bounds the round to today's
  // Yerevan day so it lines up with the real wall-clock `created_at` the
  // ingest call below stamps on its ledger row (postLedgerEntry never
  // backdates to the payment's own date).
  const { rows: templateRows } = await pool.query("SELECT * FROM bonus_challenge_templates WHERE id = $1", [templateId]);
  const { round } = await ensureOnceRound(templateRows[0], new Date());

  // 3. A real collection (payment approval) comes in through the real
  //    source-ingest path (Phase 3) and both earns the carrot collectible
  //    AND awards the "first accepted collection" badge (Phase 7) as a
  //    followup side effect.
  const customer = await createCustomer({ created_by: manager.id });
  const { rows: paymentRows } = await pool.query(
    `INSERT INTO payments (customer_id, customer_name_snapshot, amount_amd, payment_date, sales_manager_id, sales_manager_name_snapshot, status, created_by, approved_by, approved_at)
     VALUES ($1, 'E2E Fixture', 5000, now(), $2, 'E2E Rep', 'approved', $2, $2, now()) RETURNING id`,
    [customer.id, manager.id]
  );
  paymentId = paymentRows[0].id;
  await ingestCollectionContribution(paymentId);

  // 4. The worker tick recomputes progress, issues the target-reached
  //    outcome, finalizes the round past its validation deadline, and
  //    creates the reward claim (Phase 4/5) -- plus, since the target
  //    reached is a single_metric round (not balanced_basket), no
  //    balanced-basket badge fires here; only the collection badge from
  //    step 3 should exist yet. Progress is computed against the round's
  //    real start_at/end_at (today's Yerevan bounds); finalization is
  //    driven by the `now` passed here, so a `now` a few days out is what
  //    pushes it past validation_deadline_at without waiting in real time.
  const wellPastDeadline = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  await processRound(round, wellPastDeadline);

  // Personal bests (Phase 7) are computed for the most recently completed
  // week by the same tick in production; called directly here with the
  // week actually containing "now" (bonus_point_ledger.created_at
  // defaults to now() -- postLedgerEntry never backdates it to the
  // payment's own date) rather than the 2020 fixture dates used for the
  // round/attendance windows above.
  const currentWeek = yerevanWeekBounds(new Date());
  await updatePersonalBestsForWeek(currentWeek.startAt, currentWeek.endAt);

  // 5. The employee's own summary (Phase 6) now reflects everything: the
  //    collectible count, the claim awaiting review, the badge, and the
  //    personal best -- all through the real authenticated route.
  // app_settings.bonuses_enabled is a single shared row every bonus test
  // file toggles, and Node runs test files in parallel by default -- a
  // concurrently running file can flip it false between this test's own
  // setBonusesEnabled(true) above and this request. Re-asserting it true
  // immediately before each request that depends on it (rather than
  // relying on the one earlier call to have stuck) is the same defensive
  // re-check pattern this module's tests already use elsewhere for this
  // exact race.
  await setBonusesEnabled(true);
  const summaryAfterEarning = await apiRequest("/api/bonus-summary", { cookie: cookies.manager });
  assert.equal(summaryAfterEarning.status, 200);
  // No linked GPS-verified checkin for this fixture, so the collection
  // earns half credit (0.5 carrot, per bonusSourceIngest.js's
  // gpsVerified ? FULL_CREDIT_SCALED : HALF_CREDIT_SCALED) -- which is
  // exactly what the template's target_scaled of 1 (DB-scaled units,
  // i.e. 0.5 real) was set to match.
  assert.equal(summaryAfterEarning.data.collectibleCounts.carrot, 0.5);
  assert.ok(summaryAfterEarning.data.badges.some((b) => b.code === "first_accepted_collection"));
  assert.equal(summaryAfterEarning.data.personalBests.collectible_count.value, 0.5);
  assert.equal(summaryAfterEarning.data.claims.length, 1);
  assert.equal(summaryAfterEarning.data.claims[0].status, "awaiting_validation");
  const claimSummary = summaryAfterEarning.data.claims[0];

  // The employee summary's claim shape omits `version` (it's an
  // admin/optimistic-locking concern, not something the employee view
  // needs) -- the admin claim-detail route is the real way a reviewer
  // would get it before approving.
  const claimDetail = await apiRequest(`/api/bonus-reward-claims/${claimSummary.id}`, { cookie: cookies.admin });
  assert.equal(claimDetail.status, 200);
  const claim = claimDetail.data;

  // 6. Admin approves the claim (Phase 5) -- which also awards the
  //    "first approved reward" badge (Phase 7) to the claimant, not the
  //    approving admin.
  const approveRes = await apiRequest(`/api/bonus-reward-claims/${claim.id}/approve`, {
    method: "POST",
    cookie: cookies.admin,
    body: { expected_version: claim.version },
  });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.data.status, "approved");

  // 7. Accountant records the payout (Phase 5) -- a plain sales_manager
  //    cannot do this (canRecordBonusPayouts is not granted to that role;
  //    admin/ceo/accountant all have it, per roles.js).
  const managerPayAttempt = await apiRequest(`/api/bonus-reward-claims/${claim.id}/pay`, {
    method: "POST",
    cookie: cookies.manager,
    body: { expected_version: approveRes.data.version, payment_reference: "E2E-REF" },
  });
  assert.equal(managerPayAttempt.status, 400);

  const payRes = await apiRequest(`/api/bonus-reward-claims/${claim.id}/pay`, {
    method: "POST",
    cookie: cookies.accountant,
    body: { expected_version: approveRes.data.version, payment_reference: "E2E-REF" },
  });
  assert.equal(payRes.status, 200);
  assert.equal(payRes.data.status, "paid");

  // 8. Final summary: the claim is paid, both badges are present, and the
  //    admin/accountant themselves never received the claimant's badge.
  await setBonusesEnabled(true);
  const finalSummary = await apiRequest("/api/bonus-summary", { cookie: cookies.manager });
  assert.equal(finalSummary.status, 200);
  assert.equal(finalSummary.data.claims[0].status, "paid");
  const badgeCodes = finalSummary.data.badges.map((b) => b.code).sort();
  assert.deepEqual(badgeCodes, ["first_accepted_collection", "first_approved_reward"]);

  await setBonusesEnabled(true);
  const adminSummary = await apiRequest("/api/bonus-summary", { cookie: cookies.admin });
  assert.equal(adminSummary.status, 200);
  assert.deepEqual(adminSummary.data.badges, []);

  // 9. Turning the flag back off makes the whole employee surface
  //    unreachable again -- the module returns to fully inert, exactly as
  //    it must be in production right now.
  await setBonusesEnabled(false);
  const disabledAgain = await apiRequest("/api/bonus-summary", { cookie: cookies.manager });
  assert.equal(disabledAgain.status, 404);
});
