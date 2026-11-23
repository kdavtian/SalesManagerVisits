// The demo site shows money in US dollars (i18n.js inUsd, server/src/app.js DEMO_HEAD_META): whole words only, and a text that already
// names USD (a USD/AMD rate) is left alone.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.localStorage ??= { getItem: () => null, setItem() {} };
const { inUsd } = await import("../../client/public/js/i18n.js");

test("AMD and the Armenian word for dram become USD / dollar", () => {
  assert.equal(inUsd("Amount (AMD)"), "Amount (USD)");
  assert.equal(inUsd("AMD/L"), "USD/L");
  assert.equal(inUsd("Top scorer wins a 50,000amd bonus"), "Top scorer wins a 125 USD bonus");
  assert.equal(inUsd("8,000 դրամ"), "20 դոլար");
  assert.equal(inUsd("դրամով"), "դոլարով");
  assert.equal(inUsd("300,000 դրամից"), "750 դոլարից");
  assert.equal(inUsd("Small yellow coin: owes under 300,000 AMD"), "Small yellow coin: owes under 750 USD");
  assert.equal(inUsd("{amount} դրամ՝"), "{amount} դոլար՝");
  assert.equal(inUsd("{n} դրամանոցը"), "{n} դոլարանոցը");
});

test("other words and two-currency texts are left alone", () => {
  for (const s of ["Դրամարկղ", "դրամարկղեր", "դրամական", "դրամապանակ", "մետաղադրամ", "CASH_AMD", "Ramada", "USD to AMD rate", "USD at {rate} AMD", "USD՝ {rate} դրամով"]) {
    assert.equal(inUsd(s), s);
  }
  assert.equal(inUsd(42), 42);
});
