// Vaghinak - Sales Expert, step 2: the next-step rule of one customer (team/vaghinak/nextSteps.js), without a database.
import test from "node:test";
import assert from "node:assert/strict";
import { stepOf, taskTitleOf } from "../src/team/vaghinak/nextSteps.js";

const now = Date.parse("2026-11-16T09:00:00Z");

test("stage 1: not assessed -> assess; Real/High -> first order (High worth more); No/Low -> reassess only after 60 days", () => {
  assert.equal(stepOf({ stage: 1, potential_level: null, progress: 0 }, {}, now).kind, "assess_potential");
  const real = stepOf({ stage: 1, potential_level: 3, progress: 75 }, {}, now);
  const high = stepOf({ stage: 1, potential_level: 4, progress: 100 }, {}, now);
  assert.deepEqual([real.kind, high.kind], ["first_order", "first_order"]);
  assert.ok(high.value > real.value);
  assert.equal(stepOf({ stage: 1, potential_level: 2, progress: 50 }, { potentialUpdatedAt: "2026-11-01" }, now), null);
  assert.equal(stepOf({ stage: 1, potential_level: 2, progress: 50 }, { potentialUpdatedAt: "2026-08-01" }, now).kind, "reassess");
});

test("stage 2 offers the missing group; stage 3 asks the need, names the competitor, or raises the share; stage 4 only on a drop", () => {
  assert.deepEqual(stepOf({ stage: 2, progress: 50 }, { missingGroup: "Transmission" }, now).params, { group: "Transmission" });
  assert.equal(stepOf({ stage: 2, progress: 50 }, {}, now), null);
  assert.equal(stepOf({ stage: 3, next: "expected_volume_missing", progress: null }, {}, now).kind, "ask_need");
  assert.deepEqual(stepOf({ stage: 3, next: "more_share", progress: 50, share: 30 }, { competitor: "mobil" }, now).params, { brand: "mobil", share: 30 });
  assert.equal(stepOf({ stage: 3, next: "more_share", progress: 50, share: 30 }, {}, now).kind, "raise_share");
  assert.equal(stepOf({ stage: 4, progress: 100, litres_month: 90 }, { litresBefore: 100 }, now), null, "a 10 % dip is not a drop");
  assert.deepEqual(stepOf({ stage: 4, progress: 100, litres_month: 60 }, { litresBefore: 100 }, now).params, { before: 100, now: 60 });
});

test("a counterfeit-restricted customer gets no step; every kind has an Armenian task title", () => {
  assert.equal(stepOf({ stage: 1, potential_level: 4, progress: 100 }, { counterfeit: true }, now), null);
  for (const kind of ["assess_potential", "first_order", "reassess", "add_group", "ask_need", "raise_share_competitor", "raise_share", "keep_loyal"]) {
    const title = taskTitleOf({ kind, params: { group: "Grease", brand: "mobil" }, customer: { name: "Shop" } });
    assert.ok(title.includes("Shop") && /[Ա-֏]/.test(title), kind);
  }
});
