// Fewer notifications: the daily summary goes out once a day at 19:00
// Yerevan time, and stale packed orders are reminded about as ONE batch.
import test from "node:test";
import assert from "node:assert/strict";
import { isSummaryWindow, summaryDayKey } from "../src/dailySummary.js";
import { buildStalePackedMessage, isWarehouseWorkingTime } from "../src/stalePackedReminder.js";

test("daily summary window is 19:00-21:59 Yerevan time (UTC+4)", () => {
  assert.equal(isSummaryWindow(new Date("2026-10-08T14:59:00Z")), false); // 18:59 Yerevan
  assert.equal(isSummaryWindow(new Date("2026-10-08T15:00:00Z")), true); // 19:00
  assert.equal(isSummaryWindow(new Date("2026-10-08T17:59:00Z")), true); // 21:59
  assert.equal(isSummaryWindow(new Date("2026-10-08T18:00:00Z")), false); // 22:00 -- too late to send
  assert.equal(isSummaryWindow(new Date("2026-10-08T06:00:00Z")), false); // the old 10 am slot
});

test("the once-a-day key follows the Yerevan calendar date", () => {
  assert.equal(summaryDayKey(new Date("2026-10-08T15:30:00Z")), "2026-10-08");
  assert.equal(summaryDayKey(new Date("2026-10-08T20:30:00Z")), "2026-10-09"); // already after midnight in Yerevan
});

test("stale packed orders: one consolidated message with the count", () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, order_code: `C${i}`, customer_name: `Customer ${i}` }));
  const many = buildStalePackedMessage(five);
  assert.match(many.body, /^5 /);
  assert.ok(!many.body.includes("Customer 0"));
  const one = buildStalePackedMessage([five[0]]);
  assert.ok(one.body.includes("Customer 0"));
});

test("stale packed reminders only go out in working time: 09:00-17:59 Yerevan, Mon-Sat", () => {
  assert.equal(isWarehouseWorkingTime(new Date("2026-10-08T04:59:00Z")), false); // Thu 08:59
  assert.equal(isWarehouseWorkingTime(new Date("2026-10-08T05:00:00Z")), true); // Thu 09:00
  assert.equal(isWarehouseWorkingTime(new Date("2026-10-08T13:59:00Z")), true); // Thu 17:59
  assert.equal(isWarehouseWorkingTime(new Date("2026-10-08T14:00:00Z")), false); // Thu 18:00
  assert.equal(isWarehouseWorkingTime(new Date("2026-10-08T20:00:00Z")), false); // Fri 00:00 (night)
  assert.equal(isWarehouseWorkingTime(new Date("2026-10-10T08:00:00Z")), true); // Sat 12:00
  assert.equal(isWarehouseWorkingTime(new Date("2026-10-11T08:00:00Z")), false); // Sun 12:00
});
