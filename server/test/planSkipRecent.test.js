import test from "node:test";
import assert from "node:assert/strict";
import { skippedForRecentVisit } from "../src/utils/planSkipRecent.js";

// Visit Fri 16 Oct 2026 15:00 Yerevan = 11:00Z (owner's example: Artak, customer 10121).
const LAST = "2026-10-16T11:00:00Z";

test("visited yesterday: the plan day is skipped", () => {
  assert.equal(skippedForRecentVisit({ lastVisitAt: LAST, date: "2026-10-17", windowDays: 4, frequencyDays: 7 }), true);
});
test("4 days later is still inside the window, 5 days later plans the customer again", () => {
  assert.equal(skippedForRecentVisit({ lastVisitAt: LAST, date: "2026-10-20", windowDays: 4, frequencyDays: 7 }), true);
  assert.equal(skippedForRecentVisit({ lastVisitAt: LAST, date: "2026-10-21", windowDays: 4, frequencyDays: 7 }), false);
  assert.equal(skippedForRecentVisit({ lastVisitAt: LAST, date: "2026-10-23", windowDays: 4, frequencyDays: 7 }), false);
});
test("a visit on the plan day itself never removes the customer; setting 0 = off; never visited = kept", () => {
  assert.equal(skippedForRecentVisit({ lastVisitAt: LAST, date: "2026-10-16", windowDays: 4, frequencyDays: 7 }), false);
  assert.equal(skippedForRecentVisit({ lastVisitAt: LAST, date: "2026-10-17", windowDays: 0, frequencyDays: 7 }), false);
  assert.equal(skippedForRecentVisit({ lastVisitAt: null, date: "2026-10-17", windowDays: 4, frequencyDays: 7 }), false);
});
test("a customer on a short cadence is only skipped within that cadence", () => {
  assert.equal(skippedForRecentVisit({ lastVisitAt: LAST, date: "2026-10-18", windowDays: 4, frequencyDays: 2 }), true);
  assert.equal(skippedForRecentVisit({ lastVisitAt: LAST, date: "2026-10-19", windowDays: 4, frequencyDays: 2 }), false);
});
