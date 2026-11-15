// Vaghinak - Sales Expert, step 1: the stage rule of the sales funnel (team/vaghinak/funnel.js), without a database.
import test from "node:test";
import assert from "node:assert/strict";
import { stageOf, funnelSettingsOf } from "../src/team/vaghinak/funnel.js";

const cfg = funnelSettingsOf({});

test("defaults: Bronze 2, Silver 4, Gold 6 groups; 60 % share; 90 days", () => {
  assert.deepEqual(cfg, { groupsTarget: { bronze: 2, silver: 4, gold: 6 }, sharePct: 60, windowDays: 90 });
});

test("stage 1: a potential customer, progress by its level (not assessed = 0)", () => {
  assert.deepEqual(stageOf({ tier: "potential", potential_level: null }, cfg), { stage: 1, progress: 0, next: "first_order" });
  assert.equal(stageOf({ tier: "potential", potential_level: 3 }, cfg).progress, 75);
  assert.equal(stageOf({ tier: "potential", potential_level: 4 }, cfg).stage, 1, "High potential is still a potential customer until it buys");
});

test("stage 2 -> 3: enough product groups for the tier", () => {
  assert.deepEqual(stageOf({ tier: "silver", groups: 2 }, cfg), { stage: 2, progress: 50, next: "more_groups" });
  assert.equal(stageOf({ tier: "bronze", groups: 2, expected_volume_l: 0 }, cfg).stage, 3);
  assert.equal(stageOf({ tier: "gold", groups: 5 }, cfg).stage, 2, "Gold needs 6 groups");
});

test("stage 3 -> 4: our litres reach the share of the monthly need; no need written = cannot be measured", () => {
  assert.deepEqual(stageOf({ tier: "bronze", groups: 3, expected_volume_l: null }, cfg), { stage: 3, progress: null, next: "expected_volume_missing" });
  assert.deepEqual(stageOf({ tier: "bronze", groups: 3, litres_month: 30, expected_volume_l: 100 }, cfg), { stage: 3, progress: 50, share: 30, next: "more_share" });
  assert.deepEqual(stageOf({ tier: "bronze", groups: 3, litres_month: 60, expected_volume_l: 100 }, cfg), { stage: 4, progress: 100, share: 60, next: "keep" });
  assert.equal(stageOf({ tier: "bronze", groups: 1, litres_month: 500, expected_volume_l: 100 }, cfg).stage, 2, "the share alone does not skip the assortment stage");
});

test("settings: owner's numbers win, nonsense falls back to the defaults", () => {
  assert.deepEqual(funnelSettingsOf({ funnelGroupsGold: 7, funnelSharePct: 250, funnelWindowDays: 0 }), { groupsTarget: { bronze: 2, silver: 4, gold: 7 }, sharePct: 100, windowDays: 90 });
});
