import test from "node:test";
import assert from "node:assert/strict";
import { nextInvoiceNo, priceChangePct, sinceText } from "../../client/public/js/purchaseNumbers.js";

test("the next invoice number keeps the prefix, the year and the zero padding", () => {
  assert.equal(nextInvoiceNo("3/26"), "4/26");
  assert.equal(nextInvoiceNo("KAL 1/24"), "KAL 2/24");
  assert.equal(nextInvoiceNo("35"), "36");
  assert.equal(nextInvoiceNo("A-009"), "A-010");
  assert.equal(nextInvoiceNo(" 99 "), "100");
  assert.equal(nextInvoiceNo("no digits"), "");
  assert.equal(nextInvoiceNo(null), "");
});

test("price change in whole percent; nothing when a price is missing", () => {
  assert.equal(priceChangePct(15.24, 16), 5);
  assert.equal(priceChangePct(20, 17.6), -12);
  assert.equal(priceChangePct(0, 5), null);
  assert.equal(priceChangePct(null, 5), null);
  assert.equal(priceChangePct(10, 10), 0);
});

test("since text", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.equal(sinceText("2026-11-08T11:59:30Z", now), "0 min");
  assert.equal(sinceText("2026-11-08T09:00:00Z", now, { min: "ր", h: "ժ", d: "օր" }), "3 ժ");
  assert.equal(sinceText("2026-11-08T11:30:00Z", now), "30 min");
  assert.equal(sinceText("2026-11-08T09:00:00Z", now), "3 h");
  assert.equal(sinceText("2026-11-04T12:00:00Z", now), "4 d");
  assert.equal(sinceText("bad", now), "");
});
