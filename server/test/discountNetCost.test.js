import test from "node:test";
import assert from "node:assert/strict";
import { netCostAtPrice } from "../src/orders/discountPolicy.js";

// Workbook 2.1.0, Edge Professional EC 0w20 4 L: landing 14,033 AMD per pack, silver 31,000, gold 24,000.
// The workbook says net 28,170 (it mixes the per-litre landing cost into a per-pack price); per pack it is ~24,550.
const pack = { landing_cost_amd: 14033, net_cost_amd: 28170, unit: "4L" };

test("net cost at the silver price is computed per pack, not per litre", () => {
  const c = netCostAtPrice(pack, 31000);
  assert.ok(c > 24900 && c < 25300, String(c)); // VAT-payer method (default since 1.359.0): landing + 4 % commission + 17.5 % overhead + 50/L vehicles + VAT after the import-VAT credit + profit tax
  assert.ok(c < 31000, "a silver sale is not below cost");
});
test("a lower selling price (gold) gives a lower net cost", () => {
  assert.ok(netCostAtPrice(pack, 24000) < netCostAtPrice(pack, 31000));
});
test("1 L products: the measured overhead is higher than the old flat 790 AMD/L on a dear litre", () => {
  // landing 3,862, silver 8,700: the workbook's net 6,704 carried a flat 790 AMD/L; overhead is now 17.5 % of the price + 50/L
  const c = netCostAtPrice({ landing_cost_amd: 3862, net_cost_amd: 6704, unit: "1L" }, 8700);
  assert.ok(c > 6900 && c < 7100, String(c)); // still above the workbook's 6,704
});
test("without landing cost or pack size the flat workbook value is used", () => {
  assert.equal(netCostAtPrice({ net_cost_amd: 800 }, 900), 800);
  assert.equal(netCostAtPrice({ landing_cost_amd: 500, net_cost_amd: 800 }, 900), 800);
});
test("below landing cost there is no profit tax (VAT-payer method: only the VAT balance after the import-VAT credit)", () => {
  const c = netCostAtPrice({ landing_cost_amd: 1000, net_cost_amd: 1500, unit: "1L" }, 900);
  // landing + 4 % commission + 17.49 % of the price + 49.9 AMD per litre + (VAT in the price 150 - import VAT 160)
  assert.equal(Math.round(c), Math.round(1000 + 0.04 * 900 + 0.1749 * 900 + 49.9 + (900 - 900 / 1.2 - 160)));
});
test("the floor follows the customer's own channel: SM 4 %, CVO 2 %, CAS 0 % commission (owner, 2026-10-18)", () => {
  const sm = netCostAtPrice(pack, 31000, "SM YVN");
  const cvo = netCostAtPrice(pack, 31000, "CVO");
  const cas = netCostAtPrice(pack, 31000, "CAS");
  assert.ok(sm > cvo && cvo > cas);
  assert.equal(Math.round(netCostAtPrice(pack, 31000)), Math.round(sm)); // no channel = the dearest case
});
