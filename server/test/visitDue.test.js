import test from "node:test";
import assert from "node:assert/strict";
import { computeVisitDue, ruleWeekdaysFor } from "../src/utils/visitDue.js";

const FRI = new Set([5]);
// Tue 22 Sep 2026, 12:58 Yerevan = 08:58Z
const LAST = "2026-09-22T08:58:00Z";

test("route day inside the cadence is skipped: planned is the next Friday", () => {
  const d = computeVisitDue({ lastVisitAt: LAST, frequencyDays: 7, ruleWeekdays: FRI, today: "2026-09-26" });
  assert.equal(d.planned_date, "2026-10-02");
  assert.equal(d.overdue, false);
});

test("still visited (not overdue) on the planned date itself", () => {
  const d = computeVisitDue({ lastVisitAt: LAST, frequencyDays: 7, ruleWeekdays: FRI, today: "2026-10-02" });
  assert.equal(d.overdue, false);
});

test("overdue after the planned date, with day count", () => {
  const d = computeVisitDue({ lastVisitAt: LAST, frequencyDays: 7, ruleWeekdays: FRI, today: "2026-10-07" });
  assert.equal(d.overdue, true);
  assert.equal(d.overdue_days, 5);
});

test("no route weekday: planned = last visit + cadence", () => {
  const d = computeVisitDue({ lastVisitAt: LAST, frequencyDays: 7, ruleWeekdays: new Set(), today: "2026-09-30" });
  assert.equal(d.planned_date, "2026-09-29");
  assert.equal(d.overdue, true);
});

test("never visited is flagged", () => {
  assert.equal(computeVisitDue({ lastVisitAt: null, frequencyDays: 7, today: "2026-10-06" }).never_visited, true);
});

test("ruleWeekdaysFor matches by customer id and by area", () => {
  const rules = [
    { day_of_week: 5, customer_ids: [], areas: [{ region: "Yerevan", subregion: "Arabkir" }] },
    { day_of_week: 2, customer_ids: [9], areas: [] },
  ];
  assert.deepEqual([...ruleWeekdaysFor({ id: 1, region: "Yerevan", subregion: "Arabkir" }, rules)], [5]);
  assert.deepEqual([...ruleWeekdaysFor({ id: 9, region: "X", subregion: null }, rules)], [2]);
  assert.equal(ruleWeekdaysFor({ id: 2, region: "Yerevan", subregion: "Kentron" }, rules).size, 0);
});
