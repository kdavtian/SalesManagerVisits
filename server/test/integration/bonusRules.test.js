// DB coverage for server/src/bonusRules.js -- the versioned, prospective-
// only earning-rule lookup (docs/bonuses-design.md section 3).
// No HTTP route exists yet (added in a later phase), so this drives the
// functions directly against the real test database rather than through
// the app.
import "dotenv/config"; // bonusRules.js imports db/pool.js, which needs DATABASE_URL set at import time
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool.js";
import { getEarningRuleAt, getCurrentEarningRules, setEarningRule, EARNING_ACTIVITIES } from "../../src/bonusRules.js";
import { createUser, cleanupAll } from "./helpers.js";

// bonus_earning_rule_versions is genuinely append-only in production (see
// the migration's own comment) -- but a test file still owns cleaning up
// whatever rows IT inserts, same as every other fixture here, so a rule
// change made only to prove versioning works doesn't permanently change
// what "the current default" is for every other test (in this file, on a
// re-run, or in any other file) that queries it afterwards.
const insertedRuleVersionIds = [];

test.after(async () => {
  if (insertedRuleVersionIds.length) {
    await pool.query("DELETE FROM bonus_earning_rule_versions WHERE id = ANY($1)", [insertedRuleVersionIds]);
  }
  await cleanupAll();
});

test("getEarningRuleAt: returns the seeded default for each of the four always-on activities", async () => {
  const rules = await getCurrentEarningRules();
  assert.equal(rules.strawberry.points_per_unit, 1);
  assert.equal(rules.carrot.points_per_unit, 5);
  assert.equal(rules.apple.points_per_unit, 5);
  assert.equal(rules.cherry.points_per_unit, 3);
  for (const activity of EARNING_ACTIVITIES) assert.equal(rules[activity].enabled, true);
});

test("getEarningRuleAt: rejects an unknown activity rather than silently returning null", async () => {
  await assert.rejects(() => getEarningRuleAt("watermelon"), /unknown activity/);
});

test("setEarningRule: a new version becomes current, but never rewrites what a rule was before it", async () => {
  const admin = await createUser("admin");
  const before = await getEarningRuleAt("strawberry");
  const changedAt = new Date();

  const updated = await setEarningRule("strawberry", { pointsPerUnit: 2, effectiveAt: changedAt, createdBy: admin.id, note: "test bump" });
  insertedRuleVersionIds.push(updated.id);
  assert.equal(updated.points_per_unit, 2);

  // Querying "now" (after the change) sees the new rate.
  const after = await getEarningRuleAt("strawberry", new Date(changedAt.getTime() + 1000));
  assert.equal(after.points_per_unit, 2);
  assert.equal(after.id, updated.id);

  // Querying an instant *before* the change still sees the old rate --
  // this is the whole point of "prospective only, never retroactive".
  const stillOld = await getEarningRuleAt("strawberry", new Date(changedAt.getTime() - 1000));
  assert.equal(stillOld.points_per_unit, before.points_per_unit);
  assert.equal(stillOld.id, before.id);
});

test("setEarningRule: rejects a non-positive or fractional points value", async () => {
  await assert.rejects(() => setEarningRule("apple", { pointsPerUnit: 0 }), /positive integer/);
  await assert.rejects(() => setEarningRule("apple", { pointsPerUnit: -5 }), /positive integer/);
  await assert.rejects(() => setEarningRule("apple", { pointsPerUnit: 2.5 }), /positive integer/);
});

test("setEarningRule: rejects an unknown activity", async () => {
  await assert.rejects(() => setEarningRule("watermelon", { pointsPerUnit: 1 }), /unknown activity/);
});

test("bonus_earning_rule_versions: append-only in spirit -- history stays queryable after a change", async () => {
  const { rows } = await pool.query(
    "SELECT points_per_unit FROM bonus_earning_rule_versions WHERE activity = 'strawberry' ORDER BY effective_at ASC"
  );
  // At least the original seed row (1) plus this file's own test bump (2)
  // are both still present -- nothing was overwritten in place.
  assert.ok(rows.length >= 2, "expected more than one historical rule row for strawberry");
  assert.equal(rows[0].points_per_unit, 1);
});
