// Period-boundary helpers added to yerevanDate.js for the Bonuses module
// (see docs/bonuses-design.md section 5: "Weeks are Monday
// through Sunday. Months and years are calendar periods, never rolling
// windows... Custom ranges include both selected dates."). Every boundary
// returned is {startAt, endAt} as real UTC Date instants, inclusive
// start / exclusive end.
import test from "node:test";
import assert from "node:assert/strict";
import {
  yerevanDayBounds,
  yerevanWeekBounds,
  yerevanMonthBounds,
  yerevanYearBounds,
  yerevanCustomRangeBounds,
  yerevanDateOf,
} from "../src/utils/yerevanDate.js";

function iso(bounds) {
  return { startAt: bounds.startAt.toISOString(), endAt: bounds.endAt.toISOString() };
}

test("yerevanDayBounds: small-hours UTC instant resolves to the Yerevan day, not the UTC day", () => {
  // 21:00 UTC Aug 31 is already 01:00 Sep 1 in Yerevan (UTC+4).
  const bounds = yerevanDayBounds(new Date("2026-08-31T21:00:00.000Z"));
  assert.deepEqual(iso(bounds), { startAt: "2026-08-31T20:00:00.000Z", endAt: "2026-09-01T20:00:00.000Z" });
});

test("yerevanWeekBounds: Thursday resolves to that week's Monday-Sunday span", () => {
  // 2026-09-17 is a Thursday; Monday is the 14th, next Monday the 21st.
  const bounds = yerevanWeekBounds(new Date("2026-09-17T10:00:00.000Z"));
  assert.deepEqual(iso(bounds), { startAt: "2026-09-13T20:00:00.000Z", endAt: "2026-09-20T20:00:00.000Z" });
});

test("yerevanWeekBounds: Sunday belongs to the week that started the prior Monday, not a new one", () => {
  const sunday = yerevanWeekBounds(new Date("2026-09-20T10:00:00.000Z"));
  const thursday = yerevanWeekBounds(new Date("2026-09-17T10:00:00.000Z"));
  assert.deepEqual(iso(sunday), iso(thursday));
});

test("yerevanWeekBounds: never a rolling 7 days -- Monday itself starts at its own midnight, not 6 days back", () => {
  const bounds = yerevanWeekBounds(new Date("2026-09-14T05:00:00.000Z")); // Monday, 09:00 Yerevan
  assert.deepEqual(iso(bounds), { startAt: "2026-09-13T20:00:00.000Z", endAt: "2026-09-20T20:00:00.000Z" });
});

test("yerevanMonthBounds: calendar month, not a rolling 30 days", () => {
  const bounds = yerevanMonthBounds(new Date("2026-09-17T10:00:00.000Z"));
  assert.deepEqual(iso(bounds), { startAt: "2026-08-31T20:00:00.000Z", endAt: "2026-09-30T20:00:00.000Z" });
});

test("yerevanMonthBounds: December rolls the year over correctly", () => {
  const bounds = yerevanMonthBounds(new Date("2026-12-15T10:00:00.000Z"));
  assert.deepEqual(iso(bounds), { startAt: "2026-11-30T20:00:00.000Z", endAt: "2026-12-31T20:00:00.000Z" });
});

test("yerevanYearBounds: calendar year", () => {
  const bounds = yerevanYearBounds(new Date("2026-09-17T10:00:00.000Z"));
  assert.deepEqual(iso(bounds), { startAt: "2025-12-31T20:00:00.000Z", endAt: "2026-12-31T20:00:00.000Z" });
});

test("yerevanCustomRangeBounds: both endpoints inclusive, e.g. 5-10 May spans exactly 6 days", () => {
  const bounds = yerevanCustomRangeBounds("2026-05-05", "2026-05-10");
  assert.deepEqual(iso(bounds), { startAt: "2026-05-04T20:00:00.000Z", endAt: "2026-05-10T20:00:00.000Z" });
  const days = (bounds.endAt.getTime() - bounds.startAt.getTime()) / (24 * 60 * 60 * 1000);
  assert.equal(days, 6);
});

test("yerevanCustomRangeBounds: a single-day custom range (start === end) spans exactly one day", () => {
  const bounds = yerevanCustomRangeBounds("2026-05-05", "2026-05-05");
  const days = (bounds.endAt.getTime() - bounds.startAt.getTime()) / (24 * 60 * 60 * 1000);
  assert.equal(days, 1);
});

test("yerevanCustomRangeBounds: end date isn't silently short by a day (regression -- caught during development)", () => {
  // A naive implementation that adds 24h to the end instant and then
  // re-derives a "YYYY-MM-DD" string from its UTC (not Yerevan) calendar
  // fields ends up re-parsing that string as Yerevan midnight again --
  // landing one full day short of the real boundary. Pin the exact hour.
  const bounds = yerevanCustomRangeBounds("2026-05-05", "2026-05-10");
  assert.equal(bounds.endAt.toISOString(), "2026-05-10T20:00:00.000Z", "endAt must be Yerevan midnight of May 11, not May 10");
});

test("yerevanDateOf: attributes an instant to its Yerevan calendar date", () => {
  assert.equal(yerevanDateOf(new Date("2026-08-31T21:00:00.000Z")), "2026-09-01");
  assert.equal(yerevanDateOf(new Date("2026-08-31T19:00:00.000Z")), "2026-08-31");
  assert.equal(yerevanDateOf("2026-08-31T21:00:00.000Z"), "2026-09-01");
});
