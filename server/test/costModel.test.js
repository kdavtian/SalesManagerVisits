import test from "node:test";
import assert from "node:assert/strict";
import { landingCost, netCost, priceForNetMargin, litersOfUnit, COST_RATES_DEFAULT } from "../../client/public/js/costModel.js";
import { displayNetCost } from "../src/discountPolicy.js";

// Workbook 2.1.0 rows (Castrol, per ITEM): the defaults reproduce its Landing Cost AMD.
test("landing cost reproduces the workbook (Edge Professional EC 0w20: 1 L = 3,862, 4 L = 14,033)", () => {
  assert.equal(Math.round(landingCost({ brand: "Castrol", size: 1, items: 12, packKg: 10.08, packCostUsd: 74.52 }).amd), 3862);
  assert.equal(Math.round(landingCost({ brand: "Castrol", size: 4, items: 4, packKg: 13.48, packCostUsd: 87.56 }).amd), 14033);
});

test("an empty pack gives zero, never NaN", () => {
  const l = landingCost({ brand: "Other", size: 0, items: 0, packKg: 0, packCostUsd: 0 });
  assert.equal(l.amd, 0);
});

test("net cost = landing + 4 % price + 20 % VAT tax + 18 % profit tax + 790/L, per pack", () => {
  const n = netCost({ landing: 14033, price: 31000, liters: 4 });
  const margin = 31000 - 14033;
  assert.ok(Math.abs(n.mgr - 1240) < 0.01);
  assert.ok(Math.abs(n.vatTax - 0.2 * margin) < 0.01);
  assert.ok(Math.abs(n.ptax - 0.18 * (margin - 0.2 * margin)) < 0.01);
  assert.equal(n.fixed, 3160);
  assert.ok(Math.abs(n.net - (14033 + 1240 + n.vatTax + n.ptax + 3160)) < 0.01);
  assert.ok(n.netMargin > 0.2 && n.netMargin < 0.23);
});

test("without the fixed cost the net cost is lower by exactly 790 AMD per litre", () => {
  const a = netCost({ landing: 14033, price: 31000, liters: 4 });
  const b = netCost({ landing: 14033, price: 31000, liters: 4 }, COST_RATES_DEFAULT, { withFixed: false });
  assert.ok(Math.abs(a.net - b.net - 3160) < 0.01);
});

test("price for a target net margin round-trips (above and below landing cost)", () => {
  for (const [landing, liters, target] of [[14033, 4, 10], [14033, 4, 0], [3862, 1, 25], [8000, 1, -5], [500, 0.5, 30]]) {
    const p = priceForNetMargin({ landing, liters }, target);
    assert.ok(p > 0, `${landing}/${target}`);
    const back = netCost({ landing, price: p, liters }).netMargin * 100;
    assert.ok(Math.abs(back - target) < 0.01, `${landing} ${target} -> ${p} -> ${back}`);
  }
});

test("an impossible target gives null", () => {
  assert.equal(priceForNetMargin({ landing: 1000, liters: 1 }, 95), null);
});

test("litersOfUnit reads 4L, 0.5L, 208 L", () => {
  assert.equal(litersOfUnit("4L"), 4);
  assert.equal(litersOfUnit("0.5L"), 0.5);
  assert.equal(litersOfUnit("208 L"), 208);
  assert.equal(litersOfUnit("pcs"), 0);
});

test("the net cost shown for a product is per pack at the silver price (workbook value is not used)", () => {
  const row = { landing_cost_amd: 14033, net_cost_amd: 28170, unit: "4L", silver_price_amd: 31000, bronze_price_amd: 35000 };
  assert.ok(Math.abs(displayNetCost(row) - netCost({ landing: 14033, price: 31000, liters: 4 }).net) < 0.01);
  // no silver -> bronze; no landing -> the workbook value
  assert.ok(Math.abs(displayNetCost({ ...row, silver_price_amd: null }) - netCost({ landing: 14033, price: 35000, liters: 4 }).net) < 0.01);
  assert.equal(displayNetCost({ net_cost_amd: 800, unit: "1L", silver_price_amd: 900 }), 800);
});
