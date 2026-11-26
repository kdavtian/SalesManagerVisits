// Market data rules (reports/market/priceRules.js): per-litre prices, outlier flags, medians, freshness, the rep data-quality score.
import test from "node:test";
import assert from "node:assert/strict";
import { perUnit, median, flagEntries, aggregateMeta, qualityScore, isClean } from "../src/reports/market/priceRules.js";

const e = (o) => ({ brand_key: "mobil", line_code: "pcmo_5w30", volume: 4, unit: "L", wholesale_amd: null, retail_amd: null, ...o });

test("per litre / kg: whole AMD, null without an amount or a volume", () => {
  assert.equal(perUnit(10000, 4), 2500);
  assert.equal(perUnit(1001, 3), 334);
  assert.equal(perUnit(null, 4), null);
  assert.equal(perUnit(5000, 0), null);
  assert.equal(perUnit(4500, 0.5), 9000, "a half-kilo grease tin = 9,000 a kg");
});

test("median: odd, even (whole), skips empty values", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 5]), 3);
  assert.equal(median([1, 2]), 2, "1.5 rounds to 2");
  assert.equal(median([null, undefined, 7]), 7);
  assert.equal(median([]), null);
});

test("retail below wholesale is flagged even alone", () => {
  const [r] = flagEntries([e({ wholesale_amd: 12000, retail_amd: 11000 })]);
  assert.deepEqual(r.flags, ["retail_below_wholesale"]);
  assert.equal(r.wholesale_per_unit, 3000);
  assert.equal(r.retail_per_unit, 2750);
  assert.equal(isClean(r), false);
});

test("3x off the median of the same brand / line / volume, only with 3+ prices", () => {
  const two = flagEntries([e({ wholesale_amd: 10000 }), e({ wholesale_amd: 100000 })]);
  assert.ok(two.every(isClean), "two prices: nothing is 'normal' yet");
  const rows = flagEntries([
    e({ wholesale_amd: 10000, retail_amd: 12000 }),
    e({ wholesale_amd: 11000, retail_amd: 13000 }),
    e({ wholesale_amd: 10500, retail_amd: 125000 }), // a typo: one zero too many
    e({ wholesale_amd: 3000 }), // below a third of 10,500
    e({ volume: 1, wholesale_amd: 3000 }), // another volume: its own group
  ]);
  assert.deepEqual(rows.map((r) => r.flags), [[], [], ["retail_high"], ["wholesale_low"], []]);
  // exactly 3x is not flagged (more than 3x is)
  const edge = flagEntries([e({ wholesale_amd: 10000 }), e({ wholesale_amd: 10000 }), e({ wholesale_amd: 30000 })]);
  assert.ok(edge.every(isClean));
});

test("another brand or line is never the yardstick", () => {
  const rows = flagEntries([e({ wholesale_amd: 10000 }), e({ wholesale_amd: 10000 }), e({ wholesale_amd: 10000 }), e({ brand_key: "shell", wholesale_amd: 90000 }), e({ line_code: "atf", wholesale_amd: 90000 })]);
  assert.ok(rows.every(isClean));
});

test("freshness: latest date and distinct shops", () => {
  const m = aggregateMeta([
    { recorded_at: "2026-11-01T10:00:00Z", customer_id: 1 },
    { recorded_at: "2026-11-20T10:00:00Z", customer_id: 1 },
    { recorded_at: "2026-11-05T10:00:00Z", customer_id: 2 },
  ]);
  assert.deepEqual(m, { latest_at: "2026-11-20T10:00:00.000Z", shops: 2, entries: 3 });
  assert.deepEqual(aggregateMeta([]), { latest_at: null, shops: 0, entries: 0 });
});

test("quality score: 60 points shelf, 40 points prices reduced by the flagged share; null without visits", () => {
  assert.equal(qualityScore({ visits: 10, shelfVisits: 10, priceVisits: 10, priceEntries: 0, flaggedEntries: 0 }), 100);
  assert.equal(qualityScore({ visits: 10, shelfVisits: 5, priceVisits: 0, priceEntries: 0, flaggedEntries: 0 }), 30);
  assert.equal(qualityScore({ visits: 10, shelfVisits: 10, priceVisits: 5, priceEntries: 10, flaggedEntries: 5 }), 70);
  assert.equal(qualityScore({ visits: 0, shelfVisits: 0, priceVisits: 0, priceEntries: 0, flaggedEntries: 0 }), null);
});
