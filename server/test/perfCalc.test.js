// Tests for the one canonical Team Performance calculation engine (see
// perfCalc.js's own header comment) -- pace status, forecast, and required
// daily rate all have exactly one implementation, and these numbers drive
// real approval/reject/close decisions, so the formulas need direct
// coverage independent of clicking through the UI.
import test from "node:test";
import assert from "node:assert/strict";
import { STATUS, paceStatus, forecastResult, requiredDailyRate, kpiProgress } from "../src/perfCalc.js";

test("paceStatus: ahead of expected pace is excellent", () => {
  // 12 elapsed of 20 working days (60% through the month), 70% of target
  // already hit -- actual pace (0.7) / expected pace (0.6) = 1.17 >= 1.10.
  const status = paceStatus({ actual: 7000, target: 10000, elapsedWorkingDays: 12, totalWorkingDays: 20 });
  assert.equal(status, STATUS.EXCELLENT);
});

test("paceStatus: exactly on expected pace is on_track", () => {
  const status = paceStatus({ actual: 5000, target: 10000, elapsedWorkingDays: 10, totalWorkingDays: 20 });
  assert.equal(status, STATUS.ON_TRACK);
});

test("paceStatus: moderately behind expected pace is slightly_behind", () => {
  // Expected pace 50%, actual 43% -> ratio 0.86, within [0.85, 0.95).
  const status = paceStatus({ actual: 4300, target: 10000, elapsedWorkingDays: 10, totalWorkingDays: 20 });
  assert.equal(status, STATUS.SLIGHTLY_BEHIND);
});

test("paceStatus: well behind expected pace is at_risk", () => {
  const status = paceStatus({ actual: 1000, target: 10000, elapsedWorkingDays: 10, totalWorkingDays: 20 });
  assert.equal(status, STATUS.AT_RISK);
});

test("paceStatus: zero target, zero elapsed, or zero total working days is undefined (null), never a division error", () => {
  assert.equal(paceStatus({ actual: 100, target: 0, elapsedWorkingDays: 5, totalWorkingDays: 20 }), null);
  assert.equal(paceStatus({ actual: 100, target: 1000, elapsedWorkingDays: 0, totalWorkingDays: 20 }), null);
  assert.equal(paceStatus({ actual: 100, target: 1000, elapsedWorkingDays: 5, totalWorkingDays: 0 }), null);
});

test("forecastResult: withheld before day 3 of the month (unreliable run rate)", () => {
  assert.equal(forecastResult({ actual: 500, elapsedWorkingDays: 1, totalWorkingDays: 20 }), null);
  assert.equal(forecastResult({ actual: 1000, elapsedWorkingDays: 2, totalWorkingDays: 20 }), null);
});

test("forecastResult: simple run-rate projection from day 3 onward", () => {
  // 3000 over 3 elapsed days -> 1000/day -> 20000 over 20 working days.
  const forecast = forecastResult({ actual: 3000, elapsedWorkingDays: 3, totalWorkingDays: 20 });
  assert.equal(forecast, 20000);
});

test("requiredDailyRate: zero once target is already met or exceeded", () => {
  assert.equal(requiredDailyRate({ actual: 10000, target: 10000, remainingWorkingDays: 5 }), 0);
  assert.equal(requiredDailyRate({ actual: 15000, target: 10000, remainingWorkingDays: 5 }), 0);
});

test("requiredDailyRate: splits the remaining gap evenly across remaining working days", () => {
  const rate = requiredDailyRate({ actual: 4000, target: 10000, remainingWorkingDays: 6 });
  assert.equal(rate, 1000);
});

test("requiredDailyRate: null (target no longer reachable) when no working days remain and gap is unmet", () => {
  const rate = requiredDailyRate({ actual: 4000, target: 10000, remainingWorkingDays: 0 });
  assert.equal(rate, null);
});

test("kpiProgress: bundles all four derived numbers from one set of inputs", () => {
  const progress = kpiProgress({
    actual: 6000,
    target: 10000,
    elapsedWorkingDays: 10,
    totalWorkingDays: 20,
    remainingWorkingDays: 10,
  });
  assert.equal(progress.actual, 6000);
  assert.equal(progress.target, 10000);
  assert.equal(progress.achievement_pct, 0.6);
  assert.equal(progress.status, STATUS.EXCELLENT); // 0.6 actual pace / 0.5 expected pace = 1.2
  assert.equal(progress.forecast, 12000); // 6000/10 * 20
  assert.equal(progress.required_daily_rate, 400); // (10000-6000)/10
});

test("kpiProgress: zero target reports null achievement/status but a defined required rate of 0", () => {
  const progress = kpiProgress({
    actual: 0,
    target: 0,
    elapsedWorkingDays: 5,
    totalWorkingDays: 20,
    remainingWorkingDays: 15,
  });
  assert.equal(progress.achievement_pct, null);
  assert.equal(progress.status, null);
  assert.equal(progress.required_daily_rate, 0);
});
