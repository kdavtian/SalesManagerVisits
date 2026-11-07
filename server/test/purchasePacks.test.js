// Owner, 2026-11-07: refill suggestions are bought in whole packs -- bottles at least 5 packs (1 L / 0.5 L: 12 a pack, 4 L / 5 L: 4,
// 7 L: 3), drums (20 L and up) by the piece, at least 1. The Excel "Items per Pack" wins when known.
import test from "node:test";
import assert from "node:assert/strict";
import { roundToPacks, packRule } from "../src/products/stockForecast.js";

test("bottles: whole packs, at least 5", () => {
  assert.deepEqual(pick(roundToPacks(7, { unit: "1L" })), [5, 60]);
  assert.deepEqual(pick(roundToPacks(70, { unit: "1L" })), [6, 72]);
  assert.deepEqual(pick(roundToPacks(3, { unit: "4L" })), [5, 20]);
  assert.deepEqual(pick(roundToPacks(1, { unit: "5 L" })), [5, 20]);
  assert.deepEqual(pick(roundToPacks(1, { unit: "0,5L" })), [5, 60]);
  assert.deepEqual(pick(roundToPacks(10, { unit: "7L" })), [5, 15]);
});

test("drums: by the piece, at least one; the Excel pack size wins", () => {
  assert.deepEqual(pick(roundToPacks(0.3, { unit: "208L" })), [1, 1]);
  assert.deepEqual(pick(roundToPacks(3, { size_l: 60 })), [3, 3]);
  assert.equal(packRule({ unit: "1L", items_per_pack: 20 }).packSize, 20);
  assert.equal(packRule({ name: "Castrol stand" }).minPacks, 1, "no size (merch): no pack minimum");
});

const pick = (r) => [r.packs, r.pieces];
