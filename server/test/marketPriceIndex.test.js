// Competitor price index rules (reports/market/priceIndex.js, priceAlerts.js): groups by line and volume, medians per brand from clean
// entries of 90 days, our cheapest Bronze as the reference, gaps, margins, 6-month trend, month-on-month drops, the alert's bullets.
import test from "node:test";
import assert from "node:assert/strict";
import { buildIndex, priceDrops, monthOf, addMonth } from "../src/reports/market/priceIndex.js";
import { flagEntries } from "../src/reports/market/priceRules.js";
import { dropBullets, MAX_LINES } from "../src/reports/market/priceAlerts.js";

const now = new Date("2026-11-20T10:00:00Z");
const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();
let id = 0;
const e = (o) => ({ id: ++id, brand_key: "mobil", brand_name: "Mobil", line_code: "pcmo_5w30", volume: 4, unit: "L", customer_id: id, wholesale_amd: null, retail_amd: null, recorded_at: daysAgo(5), ...o });
const lines = [{ code: "pcmo_5w30", group_key: "pcmo", name_en: "PCMO 5W-30", name_hy: "Մարդատար 5W-30", sort_order: 40 }];

test("months: Yerevan calendar, add / subtract across a year", () => {
  assert.equal(monthOf("2026-10-31T21:30:00Z"), "2026-11", "01:30 on 1 Nov in Yerevan");
  assert.equal(addMonth("2026-01", -1), "2025-12");
  assert.equal(addMonth("2026-11", 2), "2027-01");
});

test("index: medians per brand, flagged and old prices left out, reference = our cheapest Bronze, gaps and margins", () => {
  const entries = flagEntries([
    e({ wholesale_amd: 10000, retail_amd: 12000 }),
    e({ wholesale_amd: 11000, retail_amd: 13000 }),
    e({ wholesale_amd: 12000, retail_amd: 14000 }),
    e({ wholesale_amd: 12000, retail_amd: 9000 }), // retail < wholesale: flagged, out
    e({ wholesale_amd: 4000, retail_amd: 5000, recorded_at: daysAgo(120) }), // older than 90 days: out of the median (kept for the trend)
    e({ brand_key: "shell", brand_name: "Shell", wholesale_amd: 14000 }),
  ]);
  const ours = [
    { id: 1, name: "Castrol MAGNATEC 5W-30 4L", line_code: "pcmo_5w30", volume: 4, bronze: 13200, silver: 12800, gold: 12400, retail: 16000 },
    { id: 2, name: "Castrol EDGE 5W-30 4L", line_code: "pcmo_5w30", volume: 4, bronze: 18000, silver: 17500, gold: 17000, retail: 22000 },
    { id: 3, name: "Castrol GTX 10W-40 4L", line_code: "pcmo_10w40", volume: 4, bronze: 9000, retail: 11000 },
  ];
  const idx = buildIndex(entries, ours, { now, lines });
  assert.equal(idx.groups.length, 1, "a line without a competitor price is not shown");
  const g = idx.groups[0];
  assert.equal(g.group_key, "pcmo");
  assert.deepEqual(g.ours.map((p) => p.id), [1, 2], "cheapest first");
  assert.equal(g.reference_id, 1);
  assert.equal(g.ours[0].margin_bronze, 2800);
  assert.equal(g.ours[0].margin_pct, 21);
  const mobil = g.brands.find((b) => b.brand_key === "mobil");
  assert.deepEqual([mobil.wholesale, mobil.retail, mobil.margin, mobil.margin_pct], [11000, 13000, 2000, 18]);
  assert.equal(mobil.gap_wholesale_pct, 20, "13,200 vs 11,000 = +20 %");
  assert.equal(mobil.gap_retail_pct, 23);
  assert.equal(mobil.meta.shops, 3);
  assert.deepEqual(g.brands.map((b) => b.brand_key), ["mobil", "shell"], "most shops first");
  assert.equal(g.brands[1].retail, null);
  assert.equal(g.brands[1].margin, null);
  assert.equal(mobil.trend.length, 6);
  assert.equal(mobil.trend.at(-1).month, "2026-11");
  assert.equal(mobil.trend.find((m) => m.month === "2026-07").wholesale, 4000, "the old price sits in its month");
});

test("drops: > 5 % month on month with 2+ shops in both months; wholesale first; rises and thin months ignored", () => {
  const oct = (d) => `2026-10-${String(d).padStart(2, "0")}T09:00:00Z`;
  const nov = (d) => `2026-11-${String(d).padStart(2, "0")}T09:00:00Z`;
  const entries = flagEntries([
    e({ wholesale_amd: 10000, retail_amd: 13000, recorded_at: oct(3) }),
    e({ wholesale_amd: 10000, retail_amd: 13000, recorded_at: oct(9) }),
    e({ wholesale_amd: 9000, retail_amd: 12000, recorded_at: nov(2) }),
    e({ wholesale_amd: 9200, retail_amd: 12000, recorded_at: nov(4) }),
    // Shell: only 1 price in October -> no verdict
    e({ brand_key: "shell", brand_name: "Shell", wholesale_amd: 15000, recorded_at: oct(3) }),
    e({ brand_key: "shell", brand_name: "Shell", wholesale_amd: 9000, recorded_at: nov(3) }),
    e({ brand_key: "shell", brand_name: "Shell", wholesale_amd: 9000, recorded_at: nov(5) }),
    // Zic: two prices each month, but one shop -> not "the market"
    e({ brand_key: "zic", brand_name: "Zic", customer_id: 9001, wholesale_amd: 10000, recorded_at: oct(3) }),
    e({ brand_key: "zic", brand_name: "Zic", customer_id: 9001, wholesale_amd: 10000, recorded_at: oct(5) }),
    e({ brand_key: "zic", brand_name: "Zic", customer_id: 9001, wholesale_amd: 8000, recorded_at: nov(3) }),
    e({ brand_key: "zic", brand_name: "Zic", customer_id: 9001, wholesale_amd: 8000, recorded_at: nov(5) }),
    // Motul: a rise
    e({ brand_key: "motul", brand_name: "Motul", retail_amd: 10000, recorded_at: oct(3) }),
    e({ brand_key: "motul", brand_name: "Motul", retail_amd: 10000, recorded_at: oct(4) }),
    e({ brand_key: "motul", brand_name: "Motul", retail_amd: 11000, recorded_at: nov(3) }),
    e({ brand_key: "motul", brand_name: "Motul", retail_amd: 11000, recorded_at: nov(4) }),
  ]);
  const d = priceDrops(entries, "2026-11", { lines });
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].brand_key, d[0].kind, d[0].before, d[0].after, d[0].change_pct], ["mobil", "wholesale", 10000, 9100, -9]);
  assert.match(dropBullets(d), /^• Mobil Մարդատար 5W-30 4 լ: մեծ\. 10,000 → 9,100 դր \(-9%, 4 խանութ\)$/);
});

test("margin % from the same entries as the margin (both prices)", () => {
  const idx = buildIndex(flagEntries([e({ wholesale_amd: 10000 }), e({ retail_amd: 20000 }), e({ wholesale_amd: 15000, retail_amd: 16000 })]), [], { now, lines });
  const b = idx.groups[0].brands[0];
  assert.deepEqual([b.margin, b.margin_pct], [1000, 7]);
});

test("the alert lists at most MAX_LINES brands and says how many more", () => {
  const drops = Array.from({ length: MAX_LINES + 3 }, (_, i) => ({ brand_name: `B${i}`, line_name_hy: "x", volume: 1, unit: "L", kind: "retail", before: 100, after: 90, change_pct: -10 }));
  const text = dropBullets(drops);
  assert.equal(text.split("\n").length, MAX_LINES + 1);
  assert.match(text, /և ևս 3$/);
});

test("our products: tier prices as orders price them (0 = not set, Bronze falls back, Gold pays Silver) (Codex review)", async () => {
  const { ourProducts } = await import("../src/reports/market/priceIndex.js");
  const db = {
    query: async (sql) =>
      sql.includes("FROM products")
        ? { rows: [{ id: 7, name: "Castrol GTX 10W-40 4L", brand: "Castrol", family: "GTX", unit: "4L", size_l: 4, sku_key: null, bronze_price_amd: 0, silver_price_amd: "9000", unit_price_amd: null, retail_price_amd: 0 }] }
        : sql.includes("volume_potential_lines")
          ? { rows: [{ id: 1, code: "pcmo_10w40" }] }
          : { rows: [] },
  };
  const [p] = await ourProducts(db);
  assert.deepEqual([p.line_code, p.bronze, p.silver, p.gold, p.retail], ["pcmo_10w40", 9000, 9000, 9000, null]);
});
