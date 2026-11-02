// The one matching rule of the redesigned payments (src/money/payments2/matching.js).
import test from "node:test";
import assert from "node:assert/strict";
import { planMatches, dayGap, MATCH_DAYS } from "../src/money/payments2/matching.js";

const pay = (id, day, amount, erp = "10001") => ({ id, erp, day, amount });
const row = (key, day, free, erp = "10001") => ({ key, erp, day, free });
const summary = (plan) => Object.fromEntries(plan.map((m) => [m.paymentId, m.links.map((l) => `${l.key}:${l.amount}`).join("+")]));

test("dayGap counts calendar days either way", () => {
  assert.equal(dayGap("2026-11-01", "2026-11-06"), 5);
  assert.equal(dayGap("2026-11-06", "2026-11-01"), 5);
});

test("one row = one payment, closest date wins, each row used once", () => {
  const plan = planMatches([pay(1, "2026-11-03", 50000), pay(2, "2026-11-04", 50000)], [row("A", "2026-11-04", 50000)]);
  assert.deepEqual(summary(plan), { 2: "A:50000" });
});

test("never across customers, never outside the window, never on a nearly equal amount", () => {
  const plan = planMatches(
    [pay(1, "2026-11-03", 50000, "10001"), pay(2, "2026-11-03", 70000), pay(3, "2026-11-03", 30000)],
    [row("A", "2026-11-03", 50000, "10002"), row("B", "2026-11-20", 70000), row("C", "2026-11-03", 30001)]
  );
  assert.deepEqual(plan, []);
  assert.equal(MATCH_DAYS, 5);
});

test("one row = several payments of the same shop (the accountant booked the day in one row)", () => {
  const plan = planMatches([pay(1, "2026-11-03", 20000), pay(2, "2026-11-03", 30000), pay(3, "2026-11-04", 99000)], [row("A", "2026-11-04", 50000)]);
  assert.deepEqual(summary(plan), { 1: "A:20000", 2: "A:30000" });
});

test("several rows = one payment (booked in parts)", () => {
  const plan = planMatches([pay(1, "2026-11-03", 100000)], [row("A", "2026-11-03", 60000), row("B", "2026-11-04", 40000), row("C", "2026-11-04", 15000)]);
  assert.deepEqual(summary(plan), { 1: "A:60000+B:40000" });
});

test("a row partly used earlier books only what is left of it", () => {
  const plan = planMatches([pay(5, "2026-11-03", 30000)], [row("A", "2026-11-03", 30000)]);
  assert.deepEqual(summary(plan), { 5: "A:30000" });
  assert.deepEqual(planMatches([pay(5, "2026-11-03", 50000)], [row("A", "2026-11-03", 30000)]), []);
});

test("exact pairs are taken before groups", () => {
  const plan = planMatches([pay(1, "2026-11-03", 20000), pay(2, "2026-11-03", 30000), pay(3, "2026-11-03", 50000)], [row("A", "2026-11-03", 50000)]);
  assert.deepEqual(summary(plan), { 3: "A:50000" });
});
