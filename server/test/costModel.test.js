import test from "node:test";
import assert from "node:assert/strict";
import { landingCost, netCost, priceForNetMargin, litersOfUnit, commissionPct, brandKey, mergeSavedRates, COST_RATES_DEFAULT, DEFAULT_COST_ITEMS } from "../../client/public/js/costModel.js";
import { displayNetCost } from "../src/discountPolicy.js";

// The owner's defaults since 1.359.0 are the market USD rate (366) and the VAT-payer method; the workbook's own numbers
// (rate 377.5, "VAT tax" on the margin) are reproduced by passing WB.
const WB = { ...COST_RATES_DEFAULT, rate: 377.5, vatMode: "workbook" };

test("defaults: market rate 366 and the VAT-payer method (owner, 2026-10-18)", () => {
  assert.equal(COST_RATES_DEFAULT.rate, 366);
  assert.equal(COST_RATES_DEFAULT.vatMode, "payer");
  assert.equal(netCost({ landing: 14033, price: 31000, liters: 4 }).mode, "payer");
});

// Workbook 2.1.0 rows (Castrol, per ITEM): the defaults reproduce its Landing Cost AMD.
test("landing cost reproduces the workbook (Edge Professional EC 0w20: 1 L = 3,862, 4 L = 14,033)", () => {
  assert.equal(Math.round(landingCost({ brand: "Castrol", size: 1, items: 12, packKg: 10.08, packCostUsd: 74.52 }, WB).amd), 3862);
  assert.equal(Math.round(landingCost({ brand: "Castrol", size: 4, items: 4, packKg: 13.48, packCostUsd: 87.56 }, WB).amd), 14033);
});

test("an empty pack gives zero, never NaN", () => {
  const l = landingCost({ brand: "Other", size: 0, items: 0, packKg: 0, packCostUsd: 0 });
  assert.equal(l.amd, 0);
});

test("net cost = landing + commission + overhead items + 20 % VAT tax + 18 % profit tax, per pack", () => {
  const n = netCost({ landing: 14033, price: 31000, liters: 4 }, WB);
  const margin = 31000 - 14033;
  assert.equal(n.commissionPct, 4); // no channel = dearest case: director 2 % + rep 2 %
  assert.ok(Math.abs(n.commission - 1240) < 0.01);
  assert.ok(Math.abs(n.vatTax - 0.2 * margin) < 0.01);
  assert.ok(Math.abs(n.ptax - 0.18 * (margin - 0.2 * margin)) < 0.01);
  // overhead: 17.49 % of the price plus 49.9 AMD per litre (the cash-ledger items replace the old flat 790 AMD/L)
  const pct = DEFAULT_COST_ITEMS.filter((i) => i.kind === "pct").reduce((a, i) => a + i.value, 0);
  const perL = DEFAULT_COST_ITEMS.filter((i) => i.kind === "liter").reduce((a, i) => a + i.value, 0);
  assert.ok(Math.abs(pct - 17.49) < 0.001);
  assert.ok(Math.abs(perL - 49.9) < 0.001);
  assert.ok(Math.abs(n.overhead - (31000 * 0.1749 + 4 * 49.9)) < 0.01);
  assert.ok(Math.abs(n.net - (14033 + n.commission + n.overhead + n.vatTax + n.ptax)) < 0.01);
  assert.ok(n.netMargin > 0.12 && n.netMargin < 0.16, String(n.netMargin));
});

test("commission by channel: SM 4 %, CVO/PCO/OEM 2 %, KF and CAS 0 %, no channel = 4 %", () => {
  assert.equal(commissionPct("SM YVN"), 4);
  assert.equal(commissionPct("SM Shirak"), 4);
  assert.equal(commissionPct("SM CAS"), 4); // a sales manager's channel, not the CAS garages
  assert.equal(commissionPct("CVO"), 2);
  assert.equal(commissionPct("PCO"), 2);
  assert.equal(commissionPct("OEM"), 2);
  assert.equal(commissionPct("KF"), 0);
  assert.equal(commissionPct("CAS"), 0);
  assert.equal(commissionPct(null), 4);
  const sm = netCost({ landing: 14033, price: 31000, liters: 4 }, WB, { channel: "SM YVN" });
  const cas = netCost({ landing: 14033, price: 31000, liters: 4 }, WB, { channel: "CAS" });
  assert.ok(Math.abs(sm.net - cas.net - 1240) < 0.01);
});

test("freight and legal transport are per factory: Royal and Lotos differ from Castrol, Orlen = Lotos", () => {
  const pack = { size: 1, items: 12, packKg: 10.2, packCostUsd: 40 };
  const castrol = landingCost({ brand: "Castrol", ...pack });
  const royal = landingCost({ brand: "Royal", ...pack });
  const lotos = landingCost({ brand: "Lotos", ...pack });
  const orlen = landingCost({ brand: "Orlen", ...pack });
  assert.ok(royal.tReal > castrol.tReal && lotos.tReal > castrol.tReal);
  assert.ok(Math.abs(royal.tReal / (10.2 / 12) - 0.4) < 1e-9);
  assert.ok(Math.abs(lotos.tReal / (10.2 / 12) - 0.325) < 1e-9);
  assert.equal(orlen.amd, lotos.amd);
  assert.equal(brandKey("royal"), "Royal");
  assert.equal(brandKey("Mobil"), "Other");
});

test("without the overhead items the net cost is lower by exactly those items", () => {
  const a = netCost({ landing: 14033, price: 31000, liters: 4 }, WB);
  const b = netCost({ landing: 14033, price: 31000, liters: 4 }, WB, { withFixed: false });
  assert.ok(Math.abs(a.net - b.net - a.overhead) < 0.01);
  assert.equal(b.overhead, 0);
});

test("a custom per-pack and per-litre cost is added to the net cost; a switched-off item is not", () => {
  const items = [
    ...DEFAULT_COST_ITEMS.map((i) => ({ ...i, on: false })),
    { id: "c1", label: "Warehouse rent", kind: "liter", value: 20, on: true, custom: true },
    { id: "c2", label: "Pallet", kind: "pack", value: 500, on: true, custom: true },
  ];
  const n = netCost({ landing: 10000, price: 20000, liters: 4 }, { ...COST_RATES_DEFAULT, items }, { channel: "KF" });
  assert.equal(n.overhead, 4 * 20 + 500);
  assert.equal(n.items.length, 2);
});

test("VAT-payer method: import VAT is credited, profit tax is on the real profit", () => {
  const rates = { ...COST_RATES_DEFAULT, vatMode: "payer" };
  const n = netCost({ landing: 14033, price: 31000, liters: 4 }, rates, { vatIn: 2000, channel: "SM YVN" });
  const revenueEx = 31000 / 1.2;
  assert.ok(Math.abs(n.vatTax - (31000 - revenueEx - 2000)) < 0.01); // VAT to the state after the credit
  const profitBeforeTax = revenueEx - (14033 - 2000) - n.commission - n.overhead;
  assert.ok(Math.abs(n.ptax - 0.18 * profitBeforeTax) < 0.01);
  assert.ok(Math.abs(n.net - (14033 + n.commission + n.overhead + n.vatTax + n.ptax)) < 0.01);
  // with a loss there is no profit tax
  const loss = netCost({ landing: 14033, price: 15000, liters: 4 }, rates, { vatIn: 2000 });
  assert.equal(loss.ptax, 0);
  // the payer method is kinder than the workbook's double counting of VAT
  const wb = netCost({ landing: 14033, price: 31000, liters: 4 }, WB, { channel: "SM YVN" });
  assert.ok(n.net < wb.net);
});

test("price for a target net margin round-trips (both methods, every channel kind, above and below landing cost)", () => {
  for (const vatMode of ["workbook", "payer"]) {
    for (const channel of [null, "CVO", "KF"]) {
      for (const [landing, liters, target] of [[14033, 4, 10], [14033, 4, 0], [3862, 1, 25], [8000, 1, -5], [500, 0.5, 30]]) {
        const rates = { ...COST_RATES_DEFAULT, vatMode };
        const p = priceForNetMargin({ landing, liters }, target, rates, { channel });
        assert.ok(p > 0, `${vatMode} ${channel} ${landing}/${target}`);
        const back = netCost({ landing, price: p, liters }, rates, { channel }).netMargin * 100;
        assert.ok(Math.abs(back - target) < 0.01, `${vatMode} ${channel} ${landing} ${target} -> ${p} -> ${back}`);
      }
    }
  }
});

test("an impossible target gives null", () => {
  assert.equal(priceForNetMargin({ landing: 1000, liters: 1 }, 95), null);
});

test("saved rates are merged into a complete current set; old calculator keys are ignored", () => {
  const merged = mergeSavedRates({ rate: 366, tCastrol: 9, mgr: 9, fixedPerL: 1, vatMode: "payer", items: [{ id: "office", value: 5, on: false }, { id: "x1", label: "Parking", kind: "pack", value: 100, custom: true, on: true }, { id: "bad", label: "z", kind: "nope", value: 1, custom: true }] });
  assert.equal(merged.rate, 366);
  assert.equal(merged.tLegalCastrol, COST_RATES_DEFAULT.tLegalCastrol);
  assert.equal(merged.vatMode, "payer");
  assert.equal(merged.items.find((i) => i.id === "office").value, 5);
  assert.equal(merged.items.find((i) => i.id === "office").on, false);
  assert.equal(merged.items.find((i) => i.id === "payroll").value, 8.22);
  assert.equal(merged.items.filter((i) => i.custom).length, 1);
  assert.equal(mergeSavedRates(null).rate, 366);
  assert.equal(mergeSavedRates(null).vatMode, "payer");
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
