import test from "node:test";
import assert from "node:assert/strict";
import { netCostAtPrice } from "../src/discountPolicy.js";

// Workbook 2.1.0, Edge Professional EC 0w20 4 L: landing 14,033 AMD per pack, silver 31,000, gold 24,000.
// The workbook says net 28,170 (it mixes the per-litre landing cost into a per-pack price); per pack it is ~24,550.
const pack = { landing_cost_amd: 14033, net_cost_amd: 28170, unit: "4L" };

test("net cost at the silver price is computed per pack, not per litre", () => {
  const c = netCostAtPrice(pack, 31000);
  assert.ok(c > 24200 && c < 24700, String(c));
  assert.ok(c < 31000, "a silver sale is not below cost");
});
test("a lower selling price (gold) gives a lower net cost", () => {
  assert.ok(netCostAtPrice(pack, 24000) < netCostAtPrice(pack, 31000));
});
test("1 L products match the workbook formula", () => {
  // landing 3,862, silver 8,700, bronze 9,700 -> workbook net is within the bronze/silver commission difference
  const c = netCostAtPrice({ landing_cost_amd: 3862, net_cost_amd: 6704, unit: "1L" }, 8700);
  assert.ok(Math.abs(c - 6704) < 60, String(c));
});
test("without landing cost or pack size the flat workbook value is used", () => {
  assert.equal(netCostAtPrice({ net_cost_amd: 800 }, 900), 800);
  assert.equal(netCostAtPrice({ landing_cost_amd: 500, net_cost_amd: 800 }, 900), 800);
});
test("no tax refund below landing cost", () => {
  const c = netCostAtPrice({ landing_cost_amd: 1000, net_cost_amd: 1500, unit: "1L" }, 900);
  assert.equal(Math.round(c), Math.round(1000 + 0.04 * 900 + 790));
});
