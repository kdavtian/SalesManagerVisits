// HTTP-level coverage for the reward-claims API
// (server/src/routes/bonusRewardClaims.js): listing scope (reviewer sees
// everything, a plain user sees only their own), the approve/pay state
// machine end to end, and the optimistic-lock conflict surfacing as 409.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { createDraftTemplate, publishTemplate } from "../../src/bonusChallengeTemplates.js";
import { ensureOnceRound } from "../../src/bonusChallengeRounds.js";
import { processRound } from "../../src/bonusChallengeWorker.js";
import { setBonusesEnabled } from "../../src/bonusSettings.js";

let admin;
let accountant;
let manager;
let cookies;
let claim;
let templateId;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  accountant = await createUser("accountant");
  manager = await createUser("sales_manager");
  cookies = {
    admin: await loginAs(admin.email),
    accountant: await loginAs(accountant.email),
    manager: await loginAs(manager.email),
  };

  await setBonusesEnabled(true);
  const template = await publishTemplate(
    (
      await createDraftTemplate(
        {
          title: "route test claim",
          type: "single_metric",
          audienceMode: "selected_users",
          audienceUserIds: [manager.id],
          recurrence: "once",
          firstRoundPolicy: "historical_explicit",
          customStartDate: "2020-03-01",
          customEndDate: "2020-03-01",
          validationGraceDays: 1,
          rewardAmd: 3000,
          targets: [{ metric: "strawberry", targetScaled: 2 }],
        },
        admin.id
      )
    ).id,
    admin.id
  );
  templateId = template.id;
  const { round } = await ensureOnceRound(template, new Date("2020-03-01T12:00:00Z"));
  const { rows: attendanceRows } = await pool.query(
    `INSERT INTO bonus_attendance_records (user_id, local_date, occurrence_at, qualifies) VALUES ($1, '2020-03-01', '2020-03-01T12:00:00Z', true) RETURNING id`,
    [manager.id]
  );
  await pool.query(
    `INSERT INTO bonus_point_ledger (user_id, activity, collectible_delta_scaled, points_delta_scaled, attendance_id, operation_key, created_at)
     VALUES ($1, 'strawberry', 2, 2, $2, 'route-test-claim', '2020-03-01T12:30:00Z')`,
    [manager.id, attendanceRows[0].id]
  );
  await processRound(round, new Date());
  await setBonusesEnabled(false);

  const { rows: claimRows } = await pool.query("SELECT * FROM bonus_reward_claims WHERE user_id = $1", [manager.id]);
  claim = claimRows[0];
});

test.after(async () => {
  await pool.query("DELETE FROM bonus_audit_log WHERE entity_table = 'bonus_reward_claims' AND entity_id = $1", [claim.id]);
  await pool.query("DELETE FROM bonus_reward_claims WHERE id = $1", [claim.id]);
  const { rows: roundRows } = await pool.query("SELECT id FROM bonus_challenge_rounds WHERE template_id = $1", [templateId]);
  const roundIds = roundRows.map((r) => r.id);
  if (roundIds.length) {
    await pool.query("DELETE FROM bonus_progress WHERE round_id = ANY($1)", [roundIds]);
    await pool.query("DELETE FROM bonus_round_participants WHERE round_id = ANY($1)", [roundIds]);
    await pool.query("DELETE FROM bonus_challenge_rounds WHERE id = ANY($1)", [roundIds]);
  }
  await pool.query("DELETE FROM bonus_challenge_template_targets WHERE template_id = $1", [templateId]);
  await pool.query("DELETE FROM bonus_challenge_templates WHERE id = $1", [templateId]);
  await pool.query("DELETE FROM bonus_point_ledger WHERE user_id = $1", [manager.id]);
  await pool.query("DELETE FROM bonus_attendance_records WHERE user_id = $1", [manager.id]);
  await cleanupAll();
  await stopTestServer();
});

test("GET /api/bonus-reward-claims: a reviewer sees it; a plain user sees only their own", async () => {
  const asAccountant = await apiRequest("/api/bonus-reward-claims", { cookie: cookies.accountant });
  assert.equal(asAccountant.status, 200);
  assert.ok(asAccountant.data.some((c) => c.id === claim.id));

  const asManager = await apiRequest("/api/bonus-reward-claims", { cookie: cookies.manager });
  assert.equal(asManager.status, 200);
  assert.ok(asManager.data.every((c) => c.user_id === manager.id));
});

test("POST /api/bonus-reward-claims/:id/approve then /pay: admin approves, accountant pays; a stale version 409s", async () => {
  const badVersion = await apiRequest(`/api/bonus-reward-claims/${claim.id}/approve`, {
    method: "POST",
    cookie: cookies.admin,
    body: { expected_version: claim.version + 99 },
  });
  assert.equal(badVersion.status, 409);

  const approve = await apiRequest(`/api/bonus-reward-claims/${claim.id}/approve`, {
    method: "POST",
    cookie: cookies.admin,
    body: { expected_version: claim.version },
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.data.status, "approved");

  const managerDenied = await apiRequest(`/api/bonus-reward-claims/${claim.id}/pay`, {
    method: "POST",
    cookie: cookies.manager,
    body: { expected_version: approve.data.version, payment_reference: "R1" },
  });
  assert.equal(managerDenied.status, 400); // not canRecordBonusPayouts

  const pay = await apiRequest(`/api/bonus-reward-claims/${claim.id}/pay`, {
    method: "POST",
    cookie: cookies.accountant,
    body: { expected_version: approve.data.version, payment_reference: "R1" },
  });
  assert.equal(pay.status, 200);
  assert.equal(pay.data.status, "paid");
});
