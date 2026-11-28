// Improvement plan 0.5 and 0.9 (owner, 2026-11-28): the pure rules. The "big drop" guard (erp/erpSyncGuard.js findDrops) and the nearest-rate
// fill for dollar rows of the Excel Cashflow sheet that have no rate (money/cashflow.js normalizeCashRow + fillMissingRates).
import test from "node:test";
import assert from "node:assert/strict";
import { findDrops, describeDrops, MAX_DROP, MIN_PREVIOUS } from "../src/erp/erpSyncGuard.js";
import { normalizeCashRow, fillMissingRates } from "../src/money/cashflow.js";

test("a drop of more than 20 % against a meaningful previous count is caught; small tables and missing counts never are", () => {
  assert.equal(MAX_DROP, 0.2);
  assert.equal(MIN_PREVIOUS, 50);
  const prev = { customers: 400, customers_with_debt: 200, order_lines: 12000, cashflow_lines: 3000, products: 30 };
  assert.deepEqual(findDrops({ customers: 400, customers_with_debt: 190, order_lines: 12100, cashflow_lines: 2500, products: 2 }, prev), [], "17 % and less, or a small table, pass");
  const empty = findDrops({ customers: 0, customers_with_debt: 0, order_lines: 0, cashflow_lines: 0, products: 0 }, prev);
  assert.deepEqual(empty.map((d) => d.key), ["customers", "customers_with_debt", "order_lines", "cashflow_lines"], "an empty file is caught on every big table");
  assert.equal(empty[0].drop_pct, 100);
  const half = findDrops({ customers: 399, customers_with_debt: 158 }, prev);
  assert.deepEqual(half.map((d) => [d.key, d.drop_pct]), [["customers_with_debt", 21]], "exactly the debtors falling 21 %");
  assert.deepEqual(findDrops({ order_lines: null, cashflow_lines: undefined }, prev), [], "a list the bot did not send is never compared");
  assert.deepEqual(findDrops({ customers: 0 }, {}), [], "the first sync ever has nothing to compare with");
  assert.deepEqual(findDrops({ customers: 0 }, { customers: 50 }), [], "previous count must be MORE than 50");
  assert.deepEqual(findDrops({ customers: 40 }, { customers: 51 }).length, 1);
  assert.match(describeDrops(half, "en"), /customers with debt: 200 → 158 \(−21%\)/);
  assert.match(describeDrops(half, "hy"), /պարտք ունեցող/);
});

test("a dollar row with no rate is flagged (not silently 0), then takes the rate of the nearest dollar row by date", () => {
  const flagged = normalizeCashRow({ date: "2031-03-10", amount: 100, currency: "USD", for: "Investment" });
  assert.equal(flagged.fx_missing, true);
  assert.equal(flagged.amount_amd, 0);
  assert.equal(normalizeCashRow({ date: "2031-03-10", amount: 100, currency: "USD", currency_rate: 390 }).fx_missing, false);
  assert.equal(normalizeCashRow({ date: "2031-03-10", amount: 100, currency: "USD", amount_amd: 39000 }).fx_missing, false, "an AMD amount is enough");
  assert.equal(normalizeCashRow({ date: "2031-03-10", amount: 100 }).fx_missing, false, "dram rows never need a rate");

  const rows = [
    normalizeCashRow({ date: "2031-03-01", amount: 10, currency: "USD", currency_rate: 380 }),
    normalizeCashRow({ date: "2031-03-20", amount: -5, currency: "USD", amount_amd: -1950 }), // 390 from the two amounts
    normalizeCashRow({ date: "2031-03-04", amount: 100, currency: "USD" }), // nearer to 03-01
    normalizeCashRow({ date: "2031-03-18", amount: -2, currency: "USD" }), // nearer to 03-20
    normalizeCashRow({ date: "2031-03-04", amount: 500, currency: "AMD" }),
  ];
  assert.deepEqual(fillMissingRates(rows, 400), { filled: 2, missing: 0 });
  assert.equal(rows[2].fx_rate, 380);
  assert.equal(rows[2].amount_amd, 38000);
  assert.equal(rows[2].fx_missing, false);
  assert.equal(rows[3].fx_rate, 390);
  assert.equal(rows[3].amount_amd, -780);
  assert.equal(rows[4].amount_amd, 500);
});

test("with no dollar rate in the sheet, the app's newest rate is used; with none at all the row is kept and flagged", () => {
  const a = [normalizeCashRow({ date: "2031-03-04", amount: 100, currency: "USD" })];
  assert.deepEqual(fillMissingRates(a, 385.5), { filled: 1, missing: 0 });
  assert.equal(a[0].amount_amd, 38550);
  const b = [normalizeCashRow({ date: "2031-03-04", amount: 100, currency: "USD" })];
  assert.deepEqual(fillMissingRates(b, null), { filled: 0, missing: 1 });
  assert.equal(b[0].fx_missing, true);
  assert.equal(b[0].amount_amd, 0);
  assert.equal(b[0].fx_rate, null);
});

test("a rate read from a typo'd AMD amount is not used for the neighbours; filled rows are whole AMD and marked estimated", () => {
  const rows = [
    normalizeCashRow({ date: "2031-03-01", amount: 10, currency: "USD", currency_rate: 385 }),
    normalizeCashRow({ date: "2031-03-10", amount: 100, currency: "USD", amount_amd: 3900 }), // typo: 39 AMD per dollar
    normalizeCashRow({ date: "2031-03-11", amount: 3.33, currency: "USD" }),
  ];
  assert.deepEqual(fillMissingRates(rows, null), { filled: 1, missing: 0 });
  assert.equal(rows[2].fx_rate, 385, "the typo's 39 is ignored; the typed 385 is used");
  assert.equal(rows[2].amount_amd, 1282, "whole AMD");
  assert.equal(rows[2].fx_estimated, true);
  assert.equal(rows[0].fx_estimated, false);
});
