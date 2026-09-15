// Working-day calendar math (server/src/workingDays.js) -- Mon-Sat is a
// working day, Sunday never is, company_holidays are the only other
// exception. Every pacing/forecast number in Team Performance is built on
// this.
import "dotenv/config"; // workingDays.js imports db/pool.js, which needs DATABASE_URL set at import time
import test from "node:test";
import assert from "node:assert/strict";
import { isWorkingDayOfWeek, computeWorkingDays } from "../src/workingDays.js";

function utc(y, m, d) {
  return new Date(Date.UTC(y, m, d));
}

test("isWorkingDayOfWeek: Sunday is never a working day", () => {
  assert.equal(isWorkingDayOfWeek(utc(2026, 8, 13)), false); // a Sunday
});

test("isWorkingDayOfWeek: Monday through Saturday are all working days", () => {
  for (let d = 14; d <= 19; d++) assert.equal(isWorkingDayOfWeek(utc(2026, 8, d)), true, `Sep ${d} 2026`);
});

test("computeWorkingDays: a month with no holidays counts every Mon-Sat", () => {
  // September 2026: 30 days, starts Tuesday Sep 1, ends Wednesday Sep 30.
  // 5 Sundays (6,13,20,27) minus... let's just assert the known total.
  const firstDay = utc(2026, 8, 1);
  const lastDay = utc(2026, 8, 30);
  const result = computeWorkingDays(firstDay, lastDay, lastDay, new Set());
  // 30 calendar days, Sundays are 6,13,20,27 -> 4 Sundays -> 26 working days.
  assert.equal(result.total, 26);
  assert.equal(result.elapsed, 26, "asOf is the month's last day, so everything has elapsed");
  assert.equal(result.remaining, 0);
});

test("computeWorkingDays: a holiday on a weekday is excluded from the total", () => {
  const firstDay = utc(2026, 8, 1);
  const lastDay = utc(2026, 8, 30);
  const holidays = new Set(["2026-09-07"]); // a Monday
  const result = computeWorkingDays(firstDay, lastDay, lastDay, holidays);
  assert.equal(result.total, 25, "one weekday holiday removed from the 26 working days");
});

test("computeWorkingDays: a holiday falling on a Sunday doesn't double-subtract", () => {
  const firstDay = utc(2026, 8, 1);
  const lastDay = utc(2026, 8, 30);
  const holidays = new Set(["2026-09-06"]); // already a Sunday
  const result = computeWorkingDays(firstDay, lastDay, lastDay, holidays);
  assert.equal(result.total, 26, "Sunday was never counted in the first place");
});

test("computeWorkingDays: elapsed is capped at total when asOf is mid-month", () => {
  const firstDay = utc(2026, 8, 1);
  const lastDay = utc(2026, 8, 30);
  const asOf = utc(2026, 8, 15); // Tuesday
  const result = computeWorkingDays(firstDay, lastDay, asOf, new Set());
  assert.ok(result.elapsed < result.total);
  assert.equal(result.elapsed + result.remaining, result.total);
});

test("computeWorkingDays: asOf before the month start counts zero elapsed", () => {
  const firstDay = utc(2026, 8, 1);
  const lastDay = utc(2026, 8, 30);
  const asOf = utc(2026, 7, 15); // August, before September starts
  const result = computeWorkingDays(firstDay, lastDay, asOf, new Set());
  assert.equal(result.elapsed, 0);
  assert.equal(result.remaining, result.total);
});

test("computeWorkingDays: asOf after the month end is capped at the month's last day (never elapsed > total)", () => {
  const firstDay = utc(2026, 8, 1);
  const lastDay = utc(2026, 8, 30);
  const asOf = utc(2026, 9, 15); // October, after September ends
  const result = computeWorkingDays(firstDay, lastDay, asOf, new Set());
  assert.equal(result.elapsed, result.total, "a past month reads as fully elapsed, not elapsed > total");
});
