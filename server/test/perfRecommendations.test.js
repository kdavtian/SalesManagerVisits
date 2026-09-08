// Tests for the deterministic recommendations/needs-attention engine --
// same input always produces the same output, which is what lets a CEO
// trust a flagged channel instead of treating it as a guess. See
// perfRecommendations.js's own header comment.
import test from "node:test";
import assert from "node:assert/strict";
import { kpiProgress } from "../src/perfCalc.js";
import { buildRecommendations, buildNeedsAttention } from "../src/perfRecommendations.js";

const wd = { elapsedWorkingDays: 10, totalWorkingDays: 20, remainingWorkingDays: 10 };

// Only Sales carries a target/pace since the Team Performance simplification
// (new customers, brand liters, and a Collections target were all dropped --
// see perfRecommendations.js's own header comment) -- collectedActual/Target
// are accepted here only for building the pending_amd figure below, not fed
// into a kpiProgress of their own.
function makeRow({ salesActual, salesTarget, pendingAmd = 0 }) {
  return {
    channel_id: 1,
    channel_code: "TEST",
    channel_name: "Test Channel",
    sales: kpiProgress({ actual: salesActual, target: salesTarget, ...wd }),
    collections: { pending_amd: pendingAmd },
  };
}

test("buildRecommendations: an at-risk KPI produces a high-severity pace warning", () => {
  const row = makeRow({ salesActual: 500, salesTarget: 10000 });
  const recs = buildRecommendations(row);
  const salesRec = recs.find((r) => r.kpi === "sales");
  assert.ok(salesRec, "expected a sales recommendation");
  assert.equal(salesRec.severity, "high");
  assert.match(salesRec.message, /at risk/i);
});

test("buildRecommendations: an on-pace KPI produces no pace warning", () => {
  const row = makeRow({ salesActual: 5000, salesTarget: 10000 });
  const recs = buildRecommendations(row);
  assert.equal(recs.find((r) => r.kpi === "sales" && r.message.match(/pace/i)), undefined);
});

test("buildRecommendations: pending collections at/above the flat 50,000 AMD threshold gets an info-level note", () => {
  const row = makeRow({ salesActual: 5000, salesTarget: 10000, pendingAmd: 50000 });
  const recs = buildRecommendations(row);
  const pendingRec = recs.find((r) => r.kpi === "collections" && r.severity === "info");
  assert.ok(pendingRec, "expected an info-level pending-collections note");
  assert.match(pendingRec.message, /not yet confirmed/i);
});

test("buildRecommendations: pending collections below the flat 50,000 AMD threshold produce no note", () => {
  const row = makeRow({ salesActual: 5000, salesTarget: 10000, pendingAmd: 49999 });
  const recs = buildRecommendations(row);
  assert.equal(recs.find((r) => r.severity === "info"), undefined);
});

test("buildRecommendations: results are sorted worst-first (high, then medium, then info)", () => {
  const row = makeRow({
    salesActual: 500, // at_risk -> high
    salesTarget: 10000,
    pendingAmd: 50000, // info-level note
  });
  const recs = buildRecommendations(row);
  const severities = recs.map((r) => r.severity);
  const highIdx = severities.indexOf("high");
  const infoIdx = severities.indexOf("info");
  assert.ok(highIdx !== -1 && infoIdx !== -1 && highIdx < infoIdx, "high-severity items must sort before info-severity items");
});

test("buildNeedsAttention: rolls up high/medium recommendations across channels, excludes info-only", () => {
  const atRiskRow = makeRow({ salesActual: 500, salesTarget: 10000 });
  atRiskRow.channel_name = "At Risk Channel";
  const healthyRow = makeRow({
    salesActual: 5000,
    salesTarget: 10000,
    pendingAmd: 50000, // info-only, should not appear in needs-attention
  });
  healthyRow.channel_name = "Healthy Channel";

  const needsAttention = buildNeedsAttention([atRiskRow, healthyRow]);
  assert.ok(needsAttention.every((i) => i.severity !== "info"), "needs-attention must exclude info-severity items");
  assert.ok(needsAttention.some((i) => i.channel_name === "At Risk Channel"));
  assert.ok(!needsAttention.some((i) => i.channel_name === "Healthy Channel"));
});

test("buildRecommendations: a channel fully on pace with no pending balance produces zero recommendations", () => {
  const row = makeRow({ salesActual: 5000, salesTarget: 10000 });
  assert.deepEqual(buildRecommendations(row), []);
});
