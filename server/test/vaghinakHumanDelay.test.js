import test from "node:test";
import assert from "node:assert/strict";
import { humanDelayPassed, jitteredDue, HUMAN_DELAY_MAX_MS } from "../src/vaghinak/humanDelay.js";

const at = (min, sec = 0) => new Date(Date.UTC(2026, 9, 19, 6, min, sec)); // 10:MM Yerevan

test("a message is held back by a random 0..5 minutes and goes out once that moment has passed", () => {
  const pick = () => 0.6; // 3 minutes
  assert.equal(humanDelayPassed("2026-10-19", "u1:not_started:1", at(30), { pick }), false); // due at 10:30, drawn 3 min
  assert.equal(humanDelayPassed("2026-10-19", "u1:not_started:1", at(32, 59), { pick: () => 0 }), false); // the draw is remembered
  assert.equal(humanDelayPassed("2026-10-19", "u1:not_started:1", at(33), { pick: () => 0 }), true);
});

test("the delay never exceeds 5 minutes and different people/kinds draw independently", () => {
  assert.equal(humanDelayPassed("2026-10-19", "u2:office_long:1", at(40), { pick: () => 0.999999 }), false);
  assert.equal(humanDelayPassed("2026-10-19", "u2:office_long:1", new Date(at(40).getTime() + HUMAN_DELAY_MAX_MS), { pick: () => 0.5 }), true);
  assert.equal(humanDelayPassed("2026-10-19", "u3:office_long:1", at(40), { pick: () => 0 }), true);
});

test("maxMs 0 (tests, admin run-now) means no delay", () => {
  assert.equal(humanDelayPassed("2026-10-19", "u4:x:1", at(0), { maxMs: 0 }), true);
});

test("chasers run at an irregular 3..7 minute rhythm", () => {
  assert.equal(jitteredDue("t-data", at(10), { pick: () => 0 }), true); // next in 3 min
  assert.equal(jitteredDue("t-data", at(12), { pick: () => 0 }), false);
  assert.equal(jitteredDue("t-data", at(13), { pick: () => 1 }), true); // next in 7 min
  assert.equal(jitteredDue("t-data", at(19), { pick: () => 1 }), false);
  assert.equal(jitteredDue("t-data", at(20), { pick: () => 1 }), true);
});
