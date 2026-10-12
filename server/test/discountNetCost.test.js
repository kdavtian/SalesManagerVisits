import test from "node:test";
import assert from "node:assert/strict";
import { netCostAtPrice } from "../src/discountPolicy.js";

// Workbook example: landing 3862, bronze 9700, net 5315 (real transport derived from these).
const product = { landing_cost_amd: 3862, bronze_price_amd: 9700, net_cost_amd: 5315 };

test("at the bronze price the workbook net cost is reproduced", () => {
  assert.ok(Math.abs(netCostAtPrice(product, 9700) - 5315) < 1);
});
test("a lower selling price (silver, gold) gives a lower net cost", () => {
  const silver = netCostAtPrice(product, 8700);
  const gold = netCostAtPrice(product, 6000);
  assert.ok(silver < 5315 && gold < silver);
  assert.ok(gold > 3862, "never below landing cost at a price above landing");
});
test("without landing cost the flat workbook value is used", () => {
  assert.equal(netCostAtPrice({ net_cost_amd: 800, bronze_price_amd: 1000 }, 900), 800);
});
test("a product with no bronze price is costed at its selling price", () => {
  const c = netCostAtPrice({ landing_cost_amd: 1000, bronze_price_amd: 0, net_cost_amd: 1000 }, 2000);
  assert.ok(c > 1000);
});
