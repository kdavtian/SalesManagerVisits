import { test } from "node:test";
import assert from "node:assert/strict";
import { tierListPrice } from "../src/products/tierPricing.js";

const p = (o) => ({ unit_price_amd: null, bronze_price_amd: null, silver_price_amd: null, gold_price_amd: null, ...o });

test("bronze/potential/competitor pay bronze, falling back to silver when bronze is empty", () => {
  assert.equal(tierListPrice(p({ bronze_price_amd: 100, silver_price_amd: 90 }), "bronze"), 100);
  assert.equal(tierListPrice(p({ silver_price_amd: 90 }), "bronze"), 90);
  assert.equal(tierListPrice(p({ bronze_price_amd: 100 }), "potential"), 100);
});

test("silver and gold both pay silver then bronze (gold differs only by its special prices, owner 2026-11-07)", () => {
  assert.equal(tierListPrice(p({ bronze_price_amd: 100, silver_price_amd: 90 }), "silver"), 90);
  assert.equal(tierListPrice(p({ bronze_price_amd: 100 }), "silver"), 100);
  assert.equal(tierListPrice(p({ bronze_price_amd: 100, silver_price_amd: 90, gold_price_amd: 80 }), "gold"), 90, "the Excel gold column no longer sets the price");
  assert.equal(tierListPrice(p({ bronze_price_amd: 100, gold_price_amd: 80 }), "gold"), 100);
  assert.equal(tierListPrice(p({ bronze_price_amd: 100, silver_price_amd: 90 }), "gold"), 90);
});
