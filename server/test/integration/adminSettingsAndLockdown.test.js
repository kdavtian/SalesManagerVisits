// API coverage for Administration and settings (server/src/routes/settings.js,
// server/src/routes/lockdown.js): GET /api/settings open to any
// authenticated role, PATCH admin-only with boundary validation, and
// GET/POST /api/lockdown role gating.
//
// The one test that actually ENGAGES lockdown (lockdown.js's gate is
// global, shared-database state read by every request -- see
// server/src/middleware/lockdown.js) lives in its own file,
// lockdownEngage.test.js, run in isolation by its own npm script (see
// package.json) rather than here in the main parallel suite -- engaging it
// here would 423 every other concurrently-running test file's requests
// against this same database.
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, stopTestServer, cleanupAll, createUser, apiRequest, loginAs } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { setBonusesEnabled } from "../../src/bonusSettings.js";
import { createDraftTemplate, publishTemplate } from "../../src/bonusChallengeTemplates.js";

let admin;
let manager;
let adminCookie;
let managerCookie;

test.before(async () => {
  await startTestServer();
  admin = await createUser("admin");
  manager = await createUser("sales_manager");
  adminCookie = await loginAs(admin.email);
  managerCookie = await loginAs(manager.email);
});
test.after(async () => {
  await cleanupAll();
  await stopTestServer();
});

// --- GET /api/settings: open to any authenticated role -----------------------------

test("GET /api/settings: any authenticated role (including a plain sales_manager) can read it", async () => {
  const res = await apiRequest("/api/settings", { cookie: managerCookie });
  assert.equal(res.status, 200);
  assert.ok("checkin_radius_meters" in res.data);
});

test("GET /api/settings rejects an unauthenticated request with 401", async () => {
  const res = await apiRequest("/api/settings");
  assert.equal(res.status, 401);
});

// --- PATCH /api/settings: admin-only + boundary validation --------------------------

test("PATCH /api/settings: a sales_manager gets 403; an admin can update checkin_radius_meters", async () => {
  const denied = await apiRequest("/api/settings", { method: "PATCH", cookie: managerCookie, body: { checkin_radius_meters: 200 } });
  assert.equal(denied.status, 403);

  const allowed = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { checkin_radius_meters: 200 } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.checkin_radius_meters, 200);
});

test("PATCH /api/settings: checkin_radius_meters is bounded to [10, 5000] (9 and 5001 fail; 10 and 5000 succeed)", async () => {
  const tooLow = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { checkin_radius_meters: 9 } });
  assert.equal(tooLow.status, 400);

  const tooHigh = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { checkin_radius_meters: 5001 } });
  assert.equal(tooHigh.status, 400);

  const low = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { checkin_radius_meters: 10 } });
  assert.equal(low.status, 200);

  const high = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { checkin_radius_meters: 5000 } });
  assert.equal(high.status, 200);

  // Restore a sane default so later tests/manual use of this shared DB
  // aren't left with an extreme radius.
  await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { checkin_radius_meters: 200 } });
});

test("PATCH /api/settings: default_visit_frequency_days is bounded to [1, 365]", async () => {
  const tooLow = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { default_visit_frequency_days: 0 } });
  assert.equal(tooLow.status, 400);

  const tooHigh = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { default_visit_frequency_days: 366 } });
  assert.equal(tooHigh.status, 400);
});

test("PATCH /api/settings: quick_action_visibility rejects an unknown role and a non-array id list", async () => {
  const unknownRole = await apiRequest("/api/settings", {
    method: "PATCH",
    cookie: adminCookie,
    body: { quick_action_visibility: { not_a_real_role: ["a"] } },
  });
  assert.equal(unknownRole.status, 400);

  const badShape = await apiRequest("/api/settings", {
    method: "PATCH",
    cookie: adminCookie,
    body: { quick_action_visibility: { sales_manager: "not-an-array" } },
  });
  assert.equal(badShape.status, 400);

  const valid = await apiRequest("/api/settings", {
    method: "PATCH",
    cookie: adminCookie,
    body: { quick_action_visibility: { sales_manager: ["checkin", "order"] } },
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.data.quick_action_visibility.sales_manager, ["checkin", "order"]);

  const reset = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { quick_action_visibility: null } });
  assert.equal(reset.status, 200);
});

test("PATCH /api/settings: calculator_pin must be 4-8 digits; empty string resets it", async () => {
  const invalid = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { calculator_pin: "abc" } });
  assert.equal(invalid.status, 400);

  const tooShort = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { calculator_pin: "123" } });
  assert.equal(tooShort.status, 400);

  const valid = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { calculator_pin: "1234" } });
  assert.equal(valid.status, 200);
  assert.equal(valid.data.calculator_pin_is_custom, true);

  const reset = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { calculator_pin: "" } });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.calculator_pin_is_custom, false);
});

test("PATCH /api/settings: calculator_mode_enabled must be a boolean", async () => {
  const res = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { calculator_mode_enabled: "yes" } });
  assert.equal(res.status, 400);
});

// --- bonuses_enabled: admin-only toggle, and turning it on backfills rounds --------
//
// Regression for a real production report: this flag previously had no
// admin-facing control at all (setBonusesEnabled existed but nothing ever
// called it outside tests) -- the only way to turn Bonuses on was a raw SQL
// UPDATE. Beyond just wiring up the toggle, flipping it on must not leave
// every already-published template stranded until the next hourly
// bonusChallengeWorker.js tick (same fix as the publish route itself).

test("PATCH /api/settings: bonuses_enabled is admin-only and must be a boolean", async () => {
  const forbidden = await apiRequest("/api/settings", { method: "PATCH", cookie: managerCookie, body: { bonuses_enabled: true } });
  assert.equal(forbidden.status, 403);

  const badType = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { bonuses_enabled: "yes" } });
  assert.equal(badType.status, 400);
});

test("PATCH /api/settings: turning bonuses_enabled on immediately creates rounds for already-published templates", async () => {
  await setBonusesEnabled(false);
  const draft = await createDraftTemplate(
    {
      title: "Backfilled on flag flip",
      type: "single_metric",
      audienceMode: "individual",
      audienceUserIds: [manager.id],
      recurrence: "daily",
      validationGraceDays: 3,
      targets: [{ metric: "strawberry", targetScaled: 2 }],
    },
    admin.id
  );
  await publishTemplate(draft.id, admin.id);
  try {
    const { rows: beforeRows } = await pool.query("SELECT id FROM bonus_challenge_rounds WHERE template_id = $1", [draft.id]);
    assert.equal(beforeRows.length, 0, "no round yet -- the flag is still off");

    const res = await apiRequest("/api/settings", { method: "PATCH", cookie: adminCookie, body: { bonuses_enabled: true } });
    assert.equal(res.status, 200);
    assert.equal(res.data.bonuses_enabled, true);

    const { rows: afterRows } = await pool.query("SELECT id FROM bonus_challenge_rounds WHERE template_id = $1", [draft.id]);
    assert.equal(afterRows.length, 1, "the round should exist right after the PATCH response, before any worker tick");
  } finally {
    const { rows: roundRows } = await pool.query("SELECT id FROM bonus_challenge_rounds WHERE template_id = $1", [draft.id]);
    const roundIds = roundRows.map((r) => r.id);
    if (roundIds.length) {
      await pool.query("DELETE FROM bonus_progress WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_round_participants WHERE round_id = ANY($1)", [roundIds]);
      await pool.query("DELETE FROM bonus_challenge_rounds WHERE id = ANY($1)", [roundIds]);
    }
    await pool.query("DELETE FROM bonus_challenge_template_targets WHERE template_id = $1", [draft.id]);
    await pool.query("DELETE FROM bonus_challenge_templates WHERE id = $1", [draft.id]);
    await setBonusesEnabled(false);
  }
});

// --- Lockdown: works unauthenticated, admin-only engage/lift ------------------------

test("GET /api/lockdown: works with NO cookie at all, by design", async () => {
  const res = await apiRequest("/api/lockdown");
  assert.equal(res.status, 200);
  assert.equal(typeof res.data.enabled, "boolean");
});

test("POST /api/lockdown/engage: a non-admin (sales_manager) gets 403", async () => {
  const res = await apiRequest("/api/lockdown/engage", { method: "POST", cookie: managerCookie });
  assert.equal(res.status, 403);
});

// The actual engage-then-lift round trip (real global state) lives in
// lockdownEngage.test.js, run in isolation -- see that file's header.

test("POST /api/lockdown/engage rejects an unauthenticated request with 401", async () => {
  const res = await apiRequest("/api/lockdown/engage", { method: "POST" });
  assert.equal(res.status, 401);
});
