// Armenia is a fixed UTC+4 offset, no DST -- these confirm the small-hours
// boundary (the exact window where a UTC-based "today" reads as yesterday)
// actually resolves to the Yerevan calendar date, not the instant's own
// UTC date. See yerevanDate.js's own header for the bug this guards.
import test from "node:test";
import assert from "node:assert/strict";
import { yerevanToday, yerevanMonthStart } from "../src/utils/yerevanDate.js";

test("yerevanToday: 21:00 UTC on the 31st is already the 1st in Yerevan (UTC+4)", () => {
  const now = new Date("2026-08-31T21:00:00.000Z");
  assert.equal(yerevanToday(now), "2026-09-01");
});

test("yerevanToday: 19:00 UTC on the 31st is still the 31st in Yerevan", () => {
  const now = new Date("2026-08-31T19:00:00.000Z");
  assert.equal(yerevanToday(now), "2026-08-31");
});

test("yerevanMonthStart: 21:00 UTC on the last day of the month rolls into next month's 1st", () => {
  const now = new Date("2026-08-31T21:00:00.000Z");
  assert.equal(yerevanMonthStart(now), "2026-09-01");
});

test("yerevanMonthStart: mid-month stays in the current month", () => {
  const now = new Date("2026-09-14T10:00:00.000Z");
  assert.equal(yerevanMonthStart(now), "2026-09-01");
});
