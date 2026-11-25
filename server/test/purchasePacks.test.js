// Purchase steps (owner, 2026-11-25): bottles in steps of 5 packs (5, 10, 15 ... packs; 1 L / 0.5 L: 12 a pack, 4 L / 5 L: 4, 7 L: 3),
// a 20 L canister in steps of 5 pieces, above 20 L (60 L, 208 L) by 1. The Excel "Items per Pack" wins when known. To order (roundToPacks)
// and the smart suggestions (orderStep / purchaseLine) round the same way.
import test from "node:test";
import assert from "node:assert/strict";
import { roundToPacks, packRule } from "../src/products/stockForecast.js";
import { orderStep, roundUpToStep, purchaseLine } from "../src/products/purchaseSuggestion.js";

test("bottles: steps of 5 packs", () => {
  assert.deepEqual(pick(roundToPacks(7, { unit: "1L" })), [5, 60]);
  assert.deepEqual(pick(roundToPacks(70, { unit: "1L" })), [10, 120], "70 bottles -> 10 packs, not 6");
  assert.deepEqual(pick(roundToPacks(121, { unit: "1L" })), [15, 180]);
  assert.deepEqual(pick(roundToPacks(3, { unit: "4L" })), [5, 20]);
  assert.deepEqual(pick(roundToPacks(21, { unit: "4L" })), [10, 40]);
  assert.deepEqual(pick(roundToPacks(1, { unit: "5 L" })), [5, 20]);
  assert.deepEqual(pick(roundToPacks(1, { unit: "0,5L" })), [5, 60]);
  assert.deepEqual(pick(roundToPacks(10, { unit: "7L" })), [5, 15]);
  assert.equal(packRule({ unit: "1L", items_per_pack: 20 }).packSize, 20);
  assert.equal(orderStep({ unit: "1L", items_per_pack: 20 }).stepPieces, 100);
});

test("20 L: steps of 5 pieces; above 20 L by 1; merchandise by the piece", () => {
  assert.deepEqual(pick(roundToPacks(1, { unit: "20L" })), [5, 5]);
  assert.deepEqual(pick(roundToPacks(6, { unit: "20 L" })), [10, 10]);
  assert.deepEqual(pick(roundToPacks(0.3, { unit: "208L" })), [1, 1]);
  assert.deepEqual(pick(roundToPacks(3, { size_l: 60 })), [3, 3]);
  assert.deepEqual(pick(roundToPacks(2, { unit: "25L" })), [2, 2], "between 20 L and 60 L: by 1 (owner, 2026-11-25)");
  assert.equal(orderStep({ name: "Castrol stand" }).stepPieces, 1, "no size, no pack size: by the piece");
  assert.equal(orderStep({ unit: "4L" }).packSizeGuessed, true);
  assert.equal(orderStep({ unit: "4L", items_per_pack: 4 }).packSizeGuessed, false);
});

test("roundUpToStep: nothing needed -> 0, otherwise whole steps up", () => {
  assert.equal(roundUpToStep(0, 60), 0);
  assert.equal(roundUpToStep(-5, 60), 0);
  assert.equal(roundUpToStep(1, 60), 60);
  assert.equal(roundUpToStep(60, 60), 60);
  assert.equal(roundUpToStep(61, 60), 120);
});

test("purchaseLine: stock now, at arrival, order, after receiving, days left", () => {
  // 2 a day, 40 free, nothing coming, lead 45, cover 45, safety 10: 40 last 20 days, nothing is left when the goods come after 45, and the
  // 25 empty days are lost sales (the customer buys elsewhere): need = 2 x 45 + 10 - 0 = 100 -> 2 steps of 60 = 120, lasting 60 days
  const l = purchaseLine({ stockNow: 40, daily: 2, leadTimeDays: 45, coverDays: 45, safetyStock: 10, stepPieces: 60 });
  assert.equal(l.need, 100);
  assert.equal(l.suggested, 120);
  assert.equal(l.order, 120);
  assert.equal(l.days_now, 20);
  assert.equal(l.stock_at_arrival, 0);
  assert.equal(l.runs_out_before_arrival, true);
  assert.equal(l.after_receiving, 120);
  assert.equal(l.days_after_receiving, 60);
  // review 2026-11-25: nothing in stock, 1 a day -> buy 45 days (the cover), not 90 (it used to add the 45 days without stock)
  const empty = purchaseLine({ stockNow: 0, daily: 1, leadTimeDays: 45, coverDays: 45, stepPieces: 5 });
  assert.equal(empty.order, 45);
  assert.equal(empty.days_after_receiving, 45);
  // oversold by 30 (confirmed orders hold more than the Excel has) and 50 wanted by submitted orders: those 80 pieces are owed -- bought on
  // top of the 45 days after the arrival; after receiving, 45 are left for the shelf
  const owed = purchaseLine({ stockNow: -30, wanted: 50, daily: 1, leadTimeDays: 45, coverDays: 45, stepPieces: 5 });
  assert.equal(owed.order, 125);
  assert.equal(owed.after_receiving, 45);
  // on the way and submitted orders count; the owner lowers the order to 120
  const m = purchaseLine({ stockNow: 100, coming: 60, wanted: 10, daily: 2, leadTimeDays: 45, coverDays: 45, safetyStock: 0, stepPieces: 60, order: 120 });
  assert.equal(m.stock_at_arrival, 60, "100 + 60 - 10 - 90");
  assert.equal(m.runs_out_before_arrival, false);
  assert.equal(m.after_receiving, 180);
  assert.equal(m.days_after_receiving, 90);
  assert.equal(m.suggested, 60, "need 2 x 90 + 10 - 160 = 30 -> one step");
  // nothing needed: no order
  assert.equal(purchaseLine({ stockNow: 500, daily: 2, leadTimeDays: 45, coverDays: 45, stepPieces: 60 }).order, 0);
  // no demand: days unknown, nothing suggested
  const z = purchaseLine({ stockNow: 5, daily: 0, leadTimeDays: 45, coverDays: 45, stepPieces: 60 });
  assert.equal(z.days_now, null);
  assert.equal(z.order, 0);
});

const pick = (r) => [r.packs, r.pieces];

// Review 2026-11-25: goods already ordered join the shelf on their expected day, not today; empty days are lost sales.
import { stockAtArrival } from "../src/products/purchaseSuggestion.js";
test("stockAtArrival: lots come on their day, empty days are lost, submitted orders are served first", () => {
  // empty shelf, 100 expected in 10 days, 2 a day, lead 45: 10 days lost, then 100 - 2 x 35 = 30 left
  assert.deepEqual(stockAtArrival({ stockNow: 0, comingLots: [{ qty: 100, inDays: 10 }], daily: 2, leadTimeDays: 45 }), { atArrival: 30, backlog: 0, ranOut: true });
  // ordered today with no date: it comes with the new order at the end of the lead time and is not "sold" before
  assert.deepEqual(stockAtArrival({ stockNow: 0, comingLots: [{ qty: 90, inDays: null }], daily: 2, leadTimeDays: 45 }), { atArrival: 90, backlog: 0, ranOut: true });
  // 10 free, submitted orders want 30: 20 owed, the 50 coming on day 5 serve them first
  assert.deepEqual(stockAtArrival({ stockNow: 10, wanted: 30, comingLots: [{ qty: 50, inDays: 5 }], daily: 0, leadTimeDays: 45 }), { atArrival: 30, backlog: 0, ranOut: true });
  // late (expected after the lead time) counts at the end; a past date counts as today
  assert.equal(stockAtArrival({ stockNow: 0, comingLots: [{ qty: 40, inDays: 90 }], daily: 1, leadTimeDays: 45 }).atArrival, 40);
  assert.equal(stockAtArrival({ stockNow: 0, comingLots: [{ qty: 40, inDays: -3 }], daily: 1, leadTimeDays: 45 }).atArrival, 0);
  // a purchase already ordered for the whole need: nothing more is suggested (it used to be "sold" before it came and suggested again)
  const again = purchaseLine({ stockNow: 0, comingLots: [{ qty: 100, inDays: null }], daily: 2, leadTimeDays: 45, coverDays: 45, safetyStock: 10, stepPieces: 20 });
  assert.equal(again.order, 0);
  // what is still owed to submitted orders at the arrival is bought on top
  assert.equal(purchaseLine({ stockNow: 0, wanted: 15, daily: 1, leadTimeDays: 45, coverDays: 45, stepPieces: 5 }).order, 60);
});
