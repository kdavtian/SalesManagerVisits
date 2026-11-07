import test from "node:test";
import assert from "node:assert/strict";
import { nextInvoiceNo, parseAmount, priceChangePct, sinceText } from "../../client/public/js/purchaseNumbers.js";

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
  const EN = { min: "min", h: "h", d: "d" };
  const now = Date.parse("2026-11-08T12:00:00Z");
  assert.equal(sinceText("2026-11-08T11:59:30Z", now, EN), "0 min");
  assert.equal(sinceText("2026-11-08T09:00:00Z", now, { min: "ր", h: "ժ", d: "օր" }), "3 ժ");
  assert.equal(sinceText("2026-11-08T11:30:00Z", now, EN), "30 min");
  assert.equal(sinceText("2026-11-08T09:00:00Z", now, EN), "3 h");
  assert.equal(sinceText("2026-11-04T12:00:00Z", now, EN), "4 d");
  assert.equal(sinceText("bad", now, EN), "");
});

test("a typed amount is read as a person means it; an empty box is null; text is NaN, never a silent 0", () => {
  assert.equal(parseAmount("385"), 385);
  assert.equal(parseAmount("15,24"), 15.24);
  assert.equal(parseAmount("15.24"), 15.24);
  assert.equal(parseAmount("1 250,50"), 1250.5);
  assert.equal(parseAmount("1,250.50"), 1250.5);
  assert.equal(parseAmount("1.250,50"), 1250.5);
  assert.equal(parseAmount("1,200,000"), 1200000);
  assert.equal(parseAmount("0"), 0);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("  "), null);
  assert.ok(Number.isNaN(parseAmount("abc")));
  assert.ok(Number.isNaN(parseAmount("12x")));
  assert.ok(Number.isNaN(parseAmount("1.2.3")));
});
