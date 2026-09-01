// Tests for the deterministic recommendations/needs-attention engine --
// same input always produces the same output, which is what lets a CEO
// trust a flagged channel instead of treating it as a guess. See
// perfRecommendations.js's own header comment.
import test from "node:test";
import assert from "node:assert/strict";
import { kpiProgress } from "../src/perfCalc.js";
import { buildRecommendations, buildNeedsAttention } from "../src/perfRecommendations.js";

const wd = { elapsedWorkingDays: 10, totalWorkingDays: 20, remainingWorkingDays: 10 };

function makeRow({ salesActual, salesTarget, collectedActual, collectedTarget, pendingAmd = 0, brands = [] }) {
  return {
    channel_id: 1,
    channel_code: "TEST",
    channel_name: "Test Channel",
    sales: kpiProgress({ actual: salesActual, target: salesTarget, ...wd }),
    collections: {
      ...kpiProgress({ actual: collectedActual, target: collectedTarget, ...wd }),
      pending_amd: pendingAmd,
    },
    new_customers: kpiProgress({ actual: 2, target: 2, ...wd }),
    brands: brands.map((b) => ({ brand: b.name, ...kpiProgress({ actual: b.actual, target: b.target, ...wd }) })),
  };
}

test("buildRecommendations: an at-risk KPI produces a high-severity pace warning", () => {
  const row = makeRow({ salesActual: 500, salesTarget: 10000, collectedActual: 5000, collectedTarget: 10000 });
  const recs = buildRecommendations(row);
  const salesRec = recs.find((r) => r.kpi === "sales");
  assert.ok(salesRec, "expected a sales recommendation");
  assert.equal(salesRec.severity, "high");
  assert.match(salesRec.message, /at risk/i);
});

test("buildRecommendations: an on-pace KPI produces no pace warning", () => {
  const row = makeRow({ salesActual: 5000, salesTarget: 10000, collectedActual: 5000, collectedTarget: 10000 });
  const recs = buildRecommendations(row);
  assert.equal(recs.find((r) => r.kpi === "sales" && r.message.match(/pace/i)), undefined);
});

test("buildRecommendations: large pending collections not yet confirmed in Excel gets an info-level note", () => {
  const row = makeRow({
    salesActual: 5000,
    salesTarget: 10000,
    collectedActual: 5000,
    collectedTarget: 10000,
    pendingAmd: 2000, // 20% of target, above the 10% threshold
  });
  const recs = buildRecommendations(row);
  const pendingRec = recs.find((r) => r.kpi === "collections" && r.severity === "info");
  assert.ok(pendingRec, "expected an info-level pending-collections note");
  assert.match(pendingRec.message, /not yet confirmed/i);
});

test("buildRecommendations: small pending collections below the 10% threshold produce no note", () => {
  const row = makeRow({
    salesActual: 5000,
    salesTarget: 10000,
    collectedActual: 5000,
    collectedTarget: 10000,
    pendingAmd: 100, // 1% of target
  });
  const recs = buildRecommendations(row);
  assert.equal(recs.find((r) => r.severity === "info"), undefined);
});

test("buildRecommendations: an at-risk brand produces a tagged brand recommendation", () => {
  const row = makeRow({
    salesActual: 5000,
    salesTarget: 10000,
    collectedActual: 5000,
    collectedTarget: 10000,
    brands: [{ name: "castrol", actual: 50, target: 2000 }],
  });
  const recs = buildRecommendations(row);
  const brandRec = recs.find((r) => r.kpi === "brand:castrol");
  assert.ok(brandRec, "expected a brand-tagged recommendation");
  assert.equal(brandRec.severity, "high");
});

test("buildRecommendations: results are sorted worst-first (high, then medium, then info)", () => {
  const row = makeRow({
    salesActual: 500, // at_risk -> high
    salesTarget: 10000,
    collectedActual: 5000, // on pace -> no pace warning
    collectedTarget: 10000,
    pendingAmd: 2000, // info-level note
  });
  const recs = buildRecommendations(row);
  const severities = recs.map((r) => r.severity);
  const highIdx = severities.indexOf("high");
  const infoIdx = severities.indexOf("info");
  assert.ok(highIdx !== -1 && infoIdx !== -1 && highIdx < infoIdx, "high-severity items must sort before info-severity items");
});

test("buildNeedsAttention: rolls up high/medium recommendations across channels, excludes info-only", () => {
  const atRiskRow = makeRow({ salesActual: 500, salesTarget: 10000, collectedActual: 5000, collectedTarget: 10000 });
  atRiskRow.channel_name = "At Risk Channel";
  const healthyRow = makeRow({
    salesActual: 5000,
    salesTarget: 10000,
    collectedActual: 5000,
    collectedTarget: 10000,
    pendingAmd: 2000, // info-only, should not appear in needs-attention
  });
  healthyRow.channel_name = "Healthy Channel";

  const needsAttention = buildNeedsAttention([atRiskRow, healthyRow]);
  assert.ok(needsAttention.every((i) => i.severity !== "info"), "needs-attention must exclude info-severity items");
  assert.ok(needsAttention.some((i) => i.channel_name === "At Risk Channel"));
  assert.ok(!needsAttention.some((i) => i.channel_name === "Healthy Channel"));
});

test("buildRecommendations: a channel fully on pace with no pending balance produces zero recommendations", () => {
  const row = makeRow({ salesActual: 5000, salesTarget: 10000, collectedActual: 5000, collectedTarget: 10000 });
  assert.deepEqual(buildRecommendations(row), []);
});
