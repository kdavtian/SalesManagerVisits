// Tests for the one canonical product-pricing function (see
// pricingService.js's own header comment) -- the catalog list, the
// pricelist page, print/PDF, and the Excel export all read a product's
// price through getEffectiveProductPricing, so its date-range and
// fallback logic needs direct coverage independent of any one surface.
import test from "node:test";
import assert from "node:assert/strict";
import { getEffectiveProductPricing, isPromoActive, dateOnly } from "../src/pricingService.js";

const baseProduct = { bronze_price_amd: "10000", unit_price_amd: "12000", retail_price_amd: "15000" };

test("getEffectiveProductPricing: no promo means special is null", () => {
  const pricing = getEffectiveProductPricing(baseProduct, null, new Date(2026, 5, 15));
  assert.equal(pricing.standard, 10000);
  assert.equal(pricing.retail, 15000);
  assert.equal(pricing.special, null);
  assert.equal(pricing.specialValidFrom, null);
});

test("getEffectiveProductPricing: falls back to unit_price_amd when bronze/retail are null", () => {
  const pricing = getEffectiveProductPricing({ bronze_price_amd: null, unit_price_amd: "9000", retail_price_amd: null }, null);
  assert.equal(pricing.standard, 9000);
  assert.equal(pricing.retail, 9000);
});

test("getEffectiveProductPricing: an active promo (today within range) surfaces as special", () => {
  const promo = { promo_price_amd: "8500", starts_on: "2026-06-01", ends_on: "2026-06-30" };
  const pricing = getEffectiveProductPricing(baseProduct, promo, new Date(2026, 5, 15));
  assert.equal(pricing.special, 8500);
  assert.equal(pricing.specialValidFrom, "2026-06-01");
  assert.equal(pricing.specialValidTo, "2026-06-30");
});

test("getEffectiveProductPricing: an expired promo does not surface as special", () => {
  const promo = { promo_price_amd: "8500", starts_on: "2026-05-01", ends_on: "2026-05-31" };
  const pricing = getEffectiveProductPricing(baseProduct, promo, new Date(2026, 5, 15));
  assert.equal(pricing.special, null);
});

test("getEffectiveProductPricing: an upcoming promo does not surface as special yet", () => {
  const promo = { promo_price_amd: "8500", starts_on: "2026-07-01", ends_on: "2026-07-31" };
  const pricing = getEffectiveProductPricing(baseProduct, promo, new Date(2026, 5, 15));
  assert.equal(pricing.special, null);
});

test("getEffectiveProductPricing: boundary dates (starts_on and ends_on) are inclusive", () => {
  const promo = { promo_price_amd: "8500", starts_on: "2026-06-15", ends_on: "2026-06-15" };
  const pricing = getEffectiveProductPricing(baseProduct, promo, new Date(2026, 5, 15, 23, 0, 0));
  assert.equal(pricing.special, 8500);
});

test("isPromoActive: mirrors the same inclusive boundary logic standalone", () => {
  assert.equal(isPromoActive({ starts_on: "2026-06-01", ends_on: "2026-06-30" }, new Date("2026-06-01")), true);
  assert.equal(isPromoActive({ starts_on: "2026-06-01", ends_on: "2026-06-30" }, new Date("2026-05-31")), false);
  assert.equal(isPromoActive({ starts_on: "2026-06-01", ends_on: "2026-06-30" }, new Date("2026-07-01")), false);
});

test("dateOnly: normalizes a full ISO timestamp string to just the date", () => {
  assert.equal(dateOnly("2026-06-15T00:00:00.000Z"), "2026-06-15");
});

test("dateOnly: normalizes a JS Date to its local calendar date", () => {
  assert.equal(dateOnly(new Date(2026, 5, 15)), "2026-06-15");
});
