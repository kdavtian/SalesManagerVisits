// Pure order business logic (server/src/routes/orders.js): the v3 status
// machine, the discount calculation, and the daily order-code format.
import "dotenv/config"; // routes/orders.js imports db/pool.js, which needs DATABASE_URL set at import time
import test from "node:test";
import assert from "node:assert/strict";
import { NEXT_STATUS, applyDiscount, formatOrderCode } from "../src/routes/orders.js";

test("NEXT_STATUS: the exact v3 status machine, draft -> submitted -> confirmed -> packed_stock_out -> delivered", () => {
  assert.deepEqual(NEXT_STATUS.draft, ["submitted"]);
  assert.deepEqual(NEXT_STATUS.submitted, ["confirmed", "draft"]);
  assert.deepEqual(NEXT_STATUS.confirmed, ["packed_stock_out", "draft"]);
  assert.deepEqual(NEXT_STATUS.packed_stock_out, ["delivered", "draft"]);
  assert.deepEqual(NEXT_STATUS.delivered, [], "delivered is terminal -- no state machine exit");
});

test("NEXT_STATUS: every non-terminal state can loop back to draft except the initial draft->submitted step", () => {
  assert.ok(!NEXT_STATUS.draft.includes("draft"));
  for (const state of ["submitted", "confirmed", "packed_stock_out"]) {
    assert.ok(NEXT_STATUS[state].includes("draft"), `${state} should be able to revert to draft`);
  }
});

test("NEXT_STATUS: covers exactly the 5 known statuses, no stray states", () => {
  assert.deepEqual(Object.keys(NEXT_STATUS).sort(), ["confirmed", "delivered", "draft", "packed_stock_out", "submitted"]);
});

test("applyDiscount: a flat AMD discount subtracts directly", () => {
  assert.equal(applyDiscount(10000, 0, 1500), 8500);
});

test("applyDiscount: a percent discount multiplies", () => {
  assert.equal(applyDiscount(10000, 10, 0), 9000);
});

test("applyDiscount: flat AMD wins when both are somehow set", () => {
  assert.equal(applyDiscount(10000, 50, 1500), 8500, "discount_amd takes precedence over discount_pct");
});

test("applyDiscount: neither set returns the subtotal unchanged", () => {
  assert.equal(applyDiscount(10000, 0, 0), 10000);
});

test("applyDiscount: a flat discount larger than the subtotal floors at zero, never negative", () => {
  assert.equal(applyDiscount(1000, 0, 5000), 0);
});

test("applyDiscount: a 100% percent discount zeroes the total", () => {
  assert.equal(applyDiscount(10000, 100, 0), 0);
});

test("formatOrderCode: YYMMDD + zero-padded 2-digit daily sequence", () => {
  assert.equal(formatOrderCode(new Date(2026, 4, 30), 1), "26053001");
  assert.equal(formatOrderCode(new Date(2026, 6, 18), 27), "26071827");
});

test("formatOrderCode: single-digit month/day are zero-padded", () => {
  assert.equal(formatOrderCode(new Date(2026, 0, 5), 3), "26010503");
});

test("formatOrderCode: a sequence past 99 is not truncated (padStart only pads, never clips)", () => {
  assert.equal(formatOrderCode(new Date(2026, 0, 1), 123), "260101123");
});
