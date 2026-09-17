// Scale-2 half-unit conversion (see bonusUnits.js's own header, and
// docs/bonuses-design.md section 10: "0.5 carrot = 1 stored
// quantity unit; 2.5 points = 5 stored point units").
import test from "node:test";
import assert from "node:assert/strict";
import { toScaled, fromScaled, formatScaled, sumScaled } from "../src/bonusUnits.js";

test("toScaled: whole and half values convert to the correct stored integer", () => {
  assert.equal(toScaled(0), 0);
  assert.equal(toScaled(0.5), 1);
  assert.equal(toScaled(1), 2);
  assert.equal(toScaled(2.5), 5);
  assert.equal(toScaled(100), 200);
});

test("toScaled: rejects a value that isn't a multiple of 0.5 rather than silently rounding", () => {
  assert.throws(() => toScaled(0.3), /not a multiple of 0\.5/);
  assert.throws(() => toScaled(1.25), /not a multiple of 0\.5/);
});

test("fromScaled: is the exact inverse of toScaled across the values that matter", () => {
  for (const real of [0, 0.5, 1, 1.5, 2.5, 20, 100]) {
    assert.equal(fromScaled(toScaled(real)), real);
  }
});

test("formatScaled: whole values display with no decimal, halves with exactly one", () => {
  assert.equal(formatScaled(0), "0");
  assert.equal(formatScaled(2), "1"); // 1 carrot
  assert.equal(formatScaled(1), "0.5"); // half carrot
  assert.equal(formatScaled(5), "2.5"); // 2.5 points
  assert.equal(formatScaled(200), "100");
});

test("sumScaled: adds stored integers without reintroducing float drift", () => {
  // Forty distinct half-credit carrot units (stored as 1 each) should sum
  // to exactly 40 stored units = 20 real carrots, per the brief's own
  // worked example.
  const fortyHalves = Array(40).fill(1);
  const total = sumScaled(fortyHalves);
  assert.equal(total, 40);
  assert.equal(fromScaled(total), 20);
});

test("worked example from the brief: twenty carrots from a mix of full and half units, default weight 5", () => {
  // Twenty full-credit units (stored 2 each) plus zero halves = 20 carrots.
  const full = sumScaled(Array(20).fill(toScaled(1)));
  assert.equal(fromScaled(full), 20);
  // Forty half-credit units (stored 1 each) = 20 carrots too.
  const halves = sumScaled(Array(40).fill(toScaled(0.5)));
  assert.equal(fromScaled(halves), 20);
  // A mixture: 10 full + 20 half = 10 + 10 = 20 carrots.
  const mixed = sumScaled([...Array(10).fill(toScaled(1)), ...Array(20).fill(toScaled(0.5))]);
  assert.equal(fromScaled(mixed), 20);
  // At the default 5 points/carrot rate, all three equal 100 points.
  const POINTS_PER_CARROT = 5;
  for (const carrots of [fromScaled(full), fromScaled(halves), fromScaled(mixed)]) {
    assert.equal(carrots * POINTS_PER_CARROT, 100);
  }
});
