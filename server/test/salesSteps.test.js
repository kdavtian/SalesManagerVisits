// Vaghinak - Sales Expert, step 2: the next-step rule of one customer (team/vaghinak/nextSteps.js), without a database.
import test from "node:test";
import assert from "node:assert/strict";
import { stepOf, taskTitleOf, similarProducts, pitchesByBrand, pitchHy } from "../src/team/vaghinak/nextSteps.js";

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
  // a brand a rep added has no translation: its task names it as it was added (2026-11-19)
  const added = stepOf({ stage: 3, next: "more_share", progress: 50, share: 30 }, { competitor: "eneos", competitorName: "ENEOS" }, now);
  assert.deepEqual(added.params, { brand: "eneos", brand_name: "ENEOS", share: 30 });
  assert.ok(taskTitleOf({ ...added, customer: { name: "Shop" } }).includes("ENEOS"));
  assert.equal(stepOf({ stage: 3, next: "more_share", progress: 50, share: 30 }, {}, now).kind, "raise_share");
  assert.equal(stepOf({ stage: 4, progress: 100, litres_month: 90 }, { litresBefore: 100 }, now), null, "a 10 % dip is not a drop");
  assert.deepEqual(stepOf({ stage: 4, progress: 100, litres_month: 60 }, { litresBefore: 100 }, now).params, { before: 100, now: 60 });
});

test("a counterfeit-restricted customer gets no step; every kind has an Armenian task title", () => {
  assert.equal(stepOf({ stage: 1, potential_level: 4, progress: 100 }, { counterfeit: true }, now), null);
  for (const kind of ["assess_potential", "first_order", "reassess", "add_group", "ask_need", "raise_share_competitor", "raise_share", "keep_loyal", "replace_grey"]) {
    const title = taskTitleOf({ kind, params: { group: "Grease", brand: "mobil" }, customer: { name: "Shop" } });
    assert.ok(title.includes("Shop") && /[Ա-֏]/.test(title), kind);
  }
});

test("similar shops buy this: the 2 products of the group most shops of the same tier buy; other tiers only when the tier has none", () => {
  const rows = [
    { tier: "silver", grp: "Transmission", id: 1, name: "ATF A", shops: 5 },
    { tier: "silver", grp: "Transmission", id: 2, name: "ATF B", shops: 8 },
    { tier: "silver", grp: "Transmission", id: 3, name: "ATF C", shops: 2 },
    { tier: "gold", grp: "Transmission", id: 3, name: "ATF C", shops: 20 },
    { tier: "gold", grp: "Grease", id: 4, name: "Grease G", shops: 3 },
    { tier: "silver", grp: "Grease", id: 9, name: "Grease H", shops: 0 },
  ].filter((r) => r.shops > 0);
  const tierBuyers = new Map([["silver", new Set(Array.from({ length: 12 }, (_, i) => i))], ["gold", new Set([100, 101, 102, 103])]]);
  assert.deepEqual(similarProducts(rows, "silver", "Transmission", tierBuyers), {
    products: [{ id: 2, name: "ATF B", shops: 8 }, { id: 1, name: "ATF A", shops: 5 }],
    buyers: 12,
  });
  // nobody in silver buys grease: fall back to every tier
  assert.deepEqual(similarProducts(rows, "silver", "Grease", tierBuyers), { products: [{ id: 4, name: "Grease G", shops: 3 }], buyers: 16 });
  assert.equal(similarProducts(rows, "silver", "EV fluids", tierBuyers), null);
  // the step carries them, the old shape stays when there are none; the task title names them
  const step = stepOf({ stage: 2, progress: 50 }, { missingGroup: "Transmission", similar: similarProducts(rows, "silver", "Transmission", tierBuyers) }, now);
  assert.equal(step.params.products.length, 2);
  assert.ok(taskTitleOf({ ...step, customer: { name: "Shop" } }).includes("ATF B, ATF A"));
});

// Market facts (owner, 2026-11-26): fake / grey Castrol on the shelf -> offer the original; the competitor step says what to pitch.
test("fake or grey Castrol on the shelf -> replace_grey at any stage (counterfeit-restricted still none)", () => {
  const grey = stepOf({ stage: 3, next: "more_share", progress: 50 }, { castrolGrey: "grey", competitor: "mobil" }, now);
  assert.deepEqual([grey.kind, grey.params], ["replace_grey", { fake: false }]);
  assert.equal(stepOf({ stage: 1, potential_level: null }, { castrolGrey: "fake" }, now).params.fake, true);
  assert.equal(stepOf({ stage: 2, progress: 10 }, { castrolGrey: "fake", counterfeit: true }, now), null);
  // a step worth more stays: a High-potential first order, a customer whose litres fell
  assert.equal(stepOf({ stage: 1, potential_level: 4, progress: 100 }, { castrolGrey: "grey" }, now).kind, "first_order");
  assert.equal(stepOf({ stage: 4, progress: 100, litres_month: 60 }, { castrolGrey: "grey", litresBefore: 100 }, now).kind, "keep_loyal");
  assert.match(taskTitleOf({ ...grey, customer: { name: "Shop" } }), /օրիգինալ Castrol՝ Shop \(դարակում՝ գորշ ներմուծված Castrol\)/);
});

test("the pitch: the brand's line with most shops where we compare; gap and margins in the task title", () => {
  const index = {
    groups: [
      { line_name_hy: "Մարդատար 5W-30", line_name_en: "PCMO 5W-30", volume: 4, unit: "L", reference_id: 1, ours: [{ id: 1, margin_bronze: 4000 }], brands: [{ brand_key: "mobil", gap_wholesale_pct: -5, margin: 3000, meta: { shops: 4 } }] },
      { line_name_hy: "Մարդատար 5W-40", line_name_en: "PCMO 5W-40", volume: 1, unit: "L", reference_id: 2, ours: [{ id: 2, margin_bronze: 900 }], brands: [{ brand_key: "mobil", gap_wholesale_pct: 10, margin: 800, meta: { shops: 2 } }] },
      { line_name_hy: "ATF", line_name_en: "ATF", volume: 1, unit: "L", reference_id: null, ours: [], brands: [{ brand_key: "shell", gap_wholesale_pct: null, margin: 500, meta: { shops: 9 } }] },
    ],
  };
  const p = pitchesByBrand(index);
  assert.deepEqual([...p.keys()], ["mobil"], "no product of ours to compare: no pitch");
  assert.deepEqual([p.get("mobil").gap_pct, p.get("mobil").margin_ours, p.get("mobil").margin_theirs, p.get("mobil").volume], [-5, 4000, 3000, 4]);
  const step = stepOf({ stage: 3, next: "more_share", progress: 50, share: 20 }, { competitor: "mobil", pitch: p.get("mobil") }, now);
  assert.equal(taskTitleOf({ ...step, customer: { name: "Shop" } }).endsWith("Մարդատար 5W-30 4 լ՝ մենք 5%-ով էժան ենք, խանութի մարժան մեզ հետ 4,000 / նրանց հետ 3,000 դր"), true);
  assert.equal(pitchHy(null), "");
  assert.equal(pitchHy({ gap_pct: null, margin_ours: null, margin_theirs: 5 }), "");
});
