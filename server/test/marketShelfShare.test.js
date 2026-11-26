// Shelf share rules (reports/market/shelfShare.js): latest fresh record per shop and brand group, genuine / fake / grey Castrol,
// numeric and weighted distribution, by region / channel, month-end trend, fake / grey spots.
import test from "node:test";
import assert from "node:assert/strict";
import { brandsOn, shelfStateAt, distribution, buildShelfShare } from "../src/reports/market/shelfShare.js";

const now = new Date("2026-11-20T10:00:00Z");
const ago = (d) => new Date(now.getTime() - d * 86400000).toISOString();
let id = 0;
const rec = (customer_id, group, values, days) => ({ id: ++id, customer_id, group, values, at: ago(days) });

test("brands on a shelf: genuine, fake and grey Castrol apart; sister brands; competitors", () => {
  assert.deepEqual([...brandsOn({ castrol: ["available", "imported_us"], lotos: ["unavailable"], royal: ["full_range"], competitors: ["mobil"] })].sort(), ["castrol", "castrol_grey", "mobil", "royal"]);
  assert.deepEqual([...brandsOn({ castrol: ["fake"] })], ["castrol_fake"]);
  assert.deepEqual([...brandsOn({ castrol: ["unavailable"] })], []);
});

test("state on a date: per group the latest record, older than 60 days or later than the date left out", () => {
  const records = [rec(1, "castrol", ["available"], 50), rec(1, "castrol", ["unavailable"], 10), rec(1, "competitors", ["shell"], 70), rec(2, "castrol", ["available"], 61), rec(3, "castrol", ["fake"], -2)];
  const s = shelfStateAt(records, now);
  assert.deepEqual([...s.keys()], [1]);
  assert.deepEqual(s.get(1).state, { castrol: ["unavailable"] });
  const earlier = shelfStateAt(records, ago(20));
  assert.deepEqual(earlier.get(1).state, { castrol: ["available"], competitors: ["shell"] });
  assert.ok(earlier.has(2));
});

test("distribution: numeric over shops, weighted over litres potential", () => {
  const d = distribution([
    { customer_id: 1, potential: 300, brands: new Set(["castrol", "mobil"]) },
    { customer_id: 2, potential: 100, brands: new Set(["mobil"]) },
    { customer_id: 3, potential: null, brands: new Set(["castrol"]) },
    { customer_id: 4, potential: 0, brands: new Set() },
  ]);
  assert.equal(d.shops, 4);
  assert.equal(d.weighted_base, 400);
  const c = d.brands.find((b) => b.key === "castrol");
  const m = d.brands.find((b) => b.key === "mobil");
  assert.deepEqual([c.numeric_pct, c.weighted_pct, m.numeric_pct, m.weighted_pct], [50, 75, 50, 100]);
});

test("the report: filters, by region / channel, trend at month ends, fake and grey spots first fake", () => {
  const info = new Map([
    [1, { name: "A", region: "yerevan", sales_channel: "retail", potential: 200, rep_name: "R1" }],
    [2, { name: "B", region: "yerevan", sales_channel: "service", potential: 100, rep_name: "R1" }],
    [3, { name: "C", region: "shirak", sales_channel: "retail", potential: 100, rep_name: "R2" }],
  ]);
  const records = [
    rec(1, "castrol", ["available"], 5),
    rec(1, "competitors", ["mobil"], 5),
    rec(2, "castrol", ["imported_dubai"], 3),
    rec(3, "castrol", ["fake", "available"], 40),
    rec(1, "castrol", ["unavailable"], 25), // October: shop 1 had none
  ];
  const r = buildShelfShare(records, info, { now, names: new Map([["mobil", "Mobil"]]) });
  assert.equal(r.totals.shops, 3);
  const c = r.totals.brands.find((b) => b.key === "castrol");
  assert.deepEqual([c.shops, c.numeric_pct, c.weighted_pct], [2, 67, 75]);
  assert.equal(r.totals.brands.find((b) => b.key === "mobil").name, "Mobil");
  assert.deepEqual(r.by_region.map((g) => [g.key, g.shops, g.castrol_pct, g.fake_grey]), [["yerevan", 2, 50, 1], ["shirak", 1, 100, 1]]);
  assert.equal(r.by_region[0].top_competitor.key, "mobil");
  assert.deepEqual(r.flagged.map((f) => [f.customer_id, f.fake, f.values]), [[3, true, ["fake"]], [2, false, ["imported_dubai"]]]);
  assert.equal(r.trend.length, 6);
  const oct = r.trend.find((m) => m.month === "2026-10");
  assert.deepEqual([oct.shops, oct.castrol_pct], [2, 50], "at 31 Oct: shop 1 without Castrol, shop 3 with");
  const filtered = buildShelfShare(records, info, { now, filter: { channel: "retail" } });
  assert.equal(filtered.totals.shops, 2);
});
