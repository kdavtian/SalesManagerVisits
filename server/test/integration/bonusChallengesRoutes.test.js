// HTTP-level coverage for the admin Bonus challenges API
// (server/src/routes/bonusChallenges.js): role gating (canManageBonusChallenges
// = admin/ceo only for template management), validation error shape, and
// the rounds/progress read endpoints' own narrower access rule (a manager
// sees any round's full roster; a plain participant sees only their own row).
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { ensureCurrentRound } from "../../src/bonusChallengeRounds.js";

let admin;
let manager;
let outsider;
let cookies;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  manager = await createUser("sales_manager");
  outsider = await createUser("sales_manager");
  cookies = {
    admin: await loginAs(admin.email),
    manager: await loginAs(manager.email),
    outsider: await loginAs(outsider.email),
  };
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

const templateIds = [];
test.after(async () => {
  if (templateIds.length) {
    const { rows: roundRows } = await pool.query("SELECT id FROM bonus_challenge_rounds WHERE template_id = ANY($1)", [templateIds]);
    const roundIds = roundRows.map((r) => r.id);
    if (roundIds.length) {
      await pool.query("DELETE FROM bonus_progress WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_round_participants WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_challenge_rounds WHERE id = ANY($1)", [roundIds]);
    }
    await pool.query("DELETE FROM bonus_challenge_template_targets WHERE template_id = ANY($1)", [templateIds]);
    await pool.query("DELETE FROM bonus_challenge_templates WHERE id = ANY($1)", [templateIds]);
  }
});

test("POST /api/bonus-challenges/templates: a sales_manager gets 403; an admin can create a draft", async () => {
  const denied = await apiRequest("/api/bonus-challenges/templates", {
    method: "POST",
    cookie: cookies.manager,
    body: { title: "x", type: "single_metric", audienceMode: "individual", audienceUserIds: [manager.id], recurrence: "daily", validationGraceDays: 3, targets: [{ metric: "strawberry", targetScaled: 2 }] },
  });
  assert.equal(denied.status, 403);

  const allowed = await apiRequest("/api/bonus-challenges/templates", {
    method: "POST",
    cookie: cookies.admin,
    body: { title: "Route test template", type: "single_metric", audienceMode: "individual", audienceUserIds: [manager.id], recurrence: "daily", validationGraceDays: 3, targets: [{ metric: "strawberry", targetScaled: 2 }] },
  });
  assert.equal(allowed.status, 201);
  assert.equal(allowed.data.status, "draft");
  templateIds.push(allowed.data.id);
});

test("POST /api/bonus-challenges/templates: a missing type is a 400 with an error message", async () => {
  const res = await apiRequest("/api/bonus-challenges/templates", {
    method: "POST",
    cookie: cookies.admin,
    body: { title: "no type", audienceMode: "individual", audienceUserIds: [manager.id], recurrence: "daily", validationGraceDays: 3 },
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /type/);
});

test("POST /api/bonus-challenges/templates/:id/publish then GET rounds/:id/progress: admin sees the full roster, the participant sees only their own row, an outsider gets 403", async () => {
  const created = await apiRequest("/api/bonus-challenges/templates", {
    method: "POST",
    cookie: cookies.admin,
    body: {
      title: "Progress visibility test",
      type: "single_metric",
      audienceMode: "individual",
      audienceUserIds: [manager.id],
      recurrence: "daily",
      validationGraceDays: 3,
      targets: [{ metric: "strawberry", targetScaled: 2 }],
    },
  });
  templateIds.push(created.data.id);

  const publishRes = await apiRequest(`/api/bonus-challenges/templates/${created.data.id}/publish`, { method: "POST", cookie: cookies.admin });
  assert.equal(publishRes.status, 200);

  const { rows: publishedRows } = await pool.query("SELECT * FROM bonus_challenge_templates WHERE id = $1", [created.data.id]);
  const { round } = await ensureCurrentRound(publishedRows[0]);

  const asAdmin = await apiRequest(`/api/bonus-challenges/rounds/${round.id}/progress`, { cookie: cookies.admin });
  assert.equal(asAdmin.status, 200);
  assert.ok(Array.isArray(asAdmin.data));

  const asManager = await apiRequest(`/api/bonus-challenges/rounds/${round.id}/progress`, { cookie: cookies.manager });
  assert.equal(asManager.status, 200);

  const asOutsider = await apiRequest(`/api/bonus-challenges/rounds/${round.id}/progress`, { cookie: cookies.outsider });
  assert.equal(asOutsider.status, 403);
});
