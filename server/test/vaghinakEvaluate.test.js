// Vaghinak's control-loop rules, as pure functions: no database, no wording.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRep, flagsOf } from "../src/vaghinak/evaluate.js";
import { DEFAULTS } from "../src/vaghinak/settings.js";
import { pickVariant, addressFor, durationHy, variantCount } from "../src/vaghinak/phrases.js";

const S = DEFAULTS;
const at = (h, m = 0) => h * 60 + m;
const field = (h, m = 0) => ({ atMin: at(h, m), isOffice: false });
const office = (h, m = 0) => ({ atMin: at(h, m), isOffice: true });
const run = (nowMin, checkins, plannedCount = 25, visitedPlanned = 0) => evaluateRep({ nowMin, settings: S, checkins, plannedCount, visitedPlanned });
const kinds = (r) => r.actions.map((a) => `${a.kind}:${a.level}`);

test("late within the 30 minute grace: silent; later than that: one friendly word", () => {
  assert.deepEqual(kinds(run(at(11), [field(9, 58)])), []);
  assert.deepEqual(kinds(run(at(11), [field(10, 5)])), ["late_start:1"]);
  assert.equal(run(at(11), [field(9, 20)]).facts.lateMinutes, 0);
});

test("nobody checked in: asks after an hour, insists (mandatory level) after two", () => {
  assert.deepEqual(kinds(run(at(10, 0), [])), []);
  assert.deepEqual(kinds(run(at(10, 40), [])), ["not_started:1"]);
  assert.deepEqual(kinds(run(at(11, 45), [])), ["not_started:2"]);
});

test("office too long with visits left: reminder at 2 h, mandatory question at 2 h 45 min; no plan left = quiet", () => {
  assert.deepEqual(kinds(run(at(11, 0), [office(9, 30)])), []);
  assert.deepEqual(kinds(run(at(11, 40), [office(9, 30)])), ["office_long:1"]);
  assert.deepEqual(kinds(run(at(12, 30), [office(9, 30)])), ["office_long:2"]);
  assert.deepEqual(kinds(run(at(12, 30), [office(9, 30)], 25, 25)), []);
  assert.equal(run(at(12, 30), [office(9, 30)]).facts.officeMinutes, 180);
});

test("office streak starts at the first of the trailing office check-ins, not at an earlier one", () => {
  const r = run(at(13), [office(9, 30), field(10), office(11, 30)]);
  assert.equal(r.facts.officeMinutes, 90);
});

test("started field visits then stopped with planned visits left: reminder, then mandatory question", () => {
  assert.deepEqual(kinds(run(at(11, 59), [field(10), field(10, 45)])), []);
  assert.deepEqual(kinds(run(at(12, 10), [field(10), field(10, 45)])), ["stopped_early:1"]);
  assert.deepEqual(kinds(run(at(13, 20), [field(10), field(10, 45)])), ["stopped_early:2"]);
  assert.deepEqual(kinds(run(at(13, 20), [field(10), field(10, 45)], 5, 5)), [], "the plan is done");
});

test("after 17:30 the day is over: no nudges", () => {
  assert.deepEqual(kinds(run(at(17, 45), [field(10), field(11)])), []);
});

test("flags for the Team pulse / brief", () => {
  const r = run(at(12, 30), [office(9, 30)]);
  assert.deepEqual(flagsOf(r.facts, S, at(12, 30)).map((f) => f.code), ["office_long"]);
  assert.deepEqual(flagsOf(run(at(11), []).facts, S, at(11)).map((f) => f.code), ["not_started"]);
  assert.deepEqual(flagsOf(run(at(10), []).facts, S, at(10)), [], "not yet time to worry");
  assert.deepEqual(flagsOf(run(at(3, 30), []).facts, S, at(3, 30)), [], "night");
});

test("wording: never the same variant as the last used one, fills placeholders, no gender guessed", () => {
  const ctx = { addr: "Արտակ ջան", n: 6, dur: "2 ժամ", idle: "1 ժամ" };
  const total = variantCount("office_long", 1, "rep");
  assert.ok(total >= 5);
  const used = [];
  for (let i = 0; i < total; i++) {
    const { text, variant } = pickVariant("office_long", 1, "rep", ctx, used);
    assert.ok(!used.includes(variant), "no repeat until the bank is used up");
    assert.ok(!text.includes("{"), "all placeholders filled");
    used.push(variant);
  }
  assert.equal(new Set(used).size, total);
  const user = { name: "Artak Sargsyan", name_hy: "Արտակ Սարգսյան" };
  for (let i = 0; i < 20; i++) assert.ok(!/Ախպեր|Քույր/.test(addressFor(user, "rep")));
  assert.equal(addressFor({ ...user, vaghinak_address: "Պարոն Դավթյան" }, "management"), "Պարոն Դավթյան");
  assert.equal(addressFor(user, "management"), "Հարգելի Սարգսյան");
  assert.equal(durationHy(45), "45 րոպե");
  assert.equal(durationHy(120), "2 ժամ");
  assert.equal(durationHy(135), "2 ժամ 15 րոպե");
});
