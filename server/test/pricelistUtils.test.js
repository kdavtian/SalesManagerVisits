import test from "node:test";
import assert from "node:assert/strict";
import { nameTokens, matchGroupsToProducts, parseTechText } from "../src/pricelistImport.js";
import { modelName, formatVolume, groupByModel, formatValidUntil, formatPrice } from "../src/pricelistPdf.js";

test("nameTokens drops brand, pack size and hyphens inside grades", () => {
  assert.deepEqual(nameTokens("Castrol EDGE 0W-20 C5 4L"), ["edge", "0w20", "c5"]);
  assert.deepEqual(nameTokens("Edge Professional EC 0w20"), ["edge", "professional", "ec", "0w20"]);
});

test("each product matches its most specific group; brand must agree", () => {
  const groups = [
    { sheet: "Castrol", brand: "Castrol", name: "Edge 0w30", sizes: [1, 4], commercial: false },
    { sheet: "Castrol", brand: "Castrol", name: "Edge 0w30 LL", sizes: [4], commercial: false },
    { sheet: "Royal", brand: "Royal", name: "0W20 SP", sizes: [1, 5], commercial: false },
  ];
  const products = [
    { id: 1, name: "Castrol EDGE 0W-30 4L", brand: "Castrol", unit: "4L" },
    { id: 2, name: "Castrol EDGE 0W-30 LL 4L", brand: "Castrol", unit: "4L" },
    { id: 3, name: "Royal 0W-20 SP 5L", brand: "Royal", unit: "5L" },
    { id: 4, name: "Lotos 0W-20 SP 1L", brand: "Lotos", unit: "1L" },
  ];
  const { matches, unmatchedProducts } = matchGroupsToProducts(groups, products);
  assert.deepEqual(matches.get(groups[0]).map((p) => p.id), [1]);
  assert.deepEqual(matches.get(groups[1]).map((p) => p.id), [2]);
  assert.deepEqual(matches.get(groups[2]).map((p) => p.id), [3]);
  assert.deepEqual(unmatchedProducts.map((p) => p.id), [4]);
});

test("commercial groups only match their own pack sizes", () => {
  const g = { sheet: "Commercial", brand: "Castrol", name: "Hyspin AWS 46", sizes: [17, 208], commercial: true };
  const { matches } = matchGroupsToProducts([g], [
    { id: 1, name: "Castrol Hyspin AWS 46 208L", brand: "Castrol", unit: "208L" },
    { id: 2, name: "Castrol Hyspin AWS 46 5L", brand: "Castrol", unit: "5L" },
  ]);
  assert.deepEqual(matches.get(g).map((p) => p.id), [1]);
});

test("parseTechText splits description, specs, approvals and typical values", () => {
  const out = parseTechText(
    "Heavy duty diesel oil\nSAE 10W-40 · ACEA E7 · API CI-4/SL\nՀավանություններ՝ Cummins CES 20077 · Volvo VDS-3\nՏիպային՝ KV 40/100°C՝ 102/14.5 մմ²/վ · VI 147 · 0.866 գ/մլ"
  );
  assert.equal(out.description, "Heavy duty diesel oil");
  assert.deepEqual(out.approvals, ["Cummins CES 20077", "Volvo VDS-3"]);
  assert.ok(out.specs.some((s) => s.label === "KV 40/100°C" && s.value === "102/14.5 մմ²/վ"));
  assert.ok(out.specs.some((s) => s.label === "VI" && s.value === "147"));
  assert.ok(out.specs.some((s) => s.label === "Խտություն"));
});

test("pdf helpers: model name, volume, grouping, dates, prices", () => {
  assert.equal(modelName({ name: "Castrol EDGE 5W-40 4L" }), "Castrol EDGE 5W-40");
  assert.equal(formatVolume("4L"), "4 լ");
  assert.equal(formatVolume("0.5L"), "0.5 լ");
  assert.equal(formatValidUntil("2026-10-30"), "30.10.2026");
  assert.equal(formatPrice(1500000), "1,500,000");
  const groups = groupByModel([
    { name: "Edge 0w30 4L", brand: "Castrol", unit: "4L" },
    { name: "Edge 0w30 1L", brand: "Castrol", unit: "1L" },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items.map((p) => p.unit), ["1L", "4L"]);
});
