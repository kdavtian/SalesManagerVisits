// The monthly market report (reports/market/monthlyReport.js): the bullets and the competitor that moved most.
import test from "node:test";
import assert from "node:assert/strict";
import { summaryBullets, biggestMover } from "../src/reports/market/monthlyReport.js";

test("bullets: Castrol share with its change, the mover, price drops, fake / grey, data score", () => {
  const text = summaryBullets({
    share: { now: { shops: 40, castrol_pct: 45, castrol_weighted_pct: 60 }, before: { shops: 38, castrol_pct: 42, castrol_weighted_pct: 61 } },
    mover: { name: "Mobil", now_pct: 30, change: 5 },
    drops: [{ brand_name: "Shell", line_name_hy: "Մարդատար 5W-40", change_pct: -8 }, { brand_name: "Zic", line_name_hy: "ATF", change_pct: -6 }],
    flagged: { total: 3, fake: 1 },
    quality: { score: 72 },
  });
  assert.deepEqual(text.split("\n"), [
    "• Castrol դարակում՝ 45% (+3) խանութների, 60% (-1) ըստ լիտրի (40 խանութ)",
    "• Ամենաշատը փոխվել է՝ Mobil 30% (+5)",
    "• Գներն իջել են՝ 2 ապրանքանիշ/գիծ, ամենաշատը՝ Shell Մարդատար 5W-40 -8%",
    "• Կեղծ / գորշ Castrol՝ 3 խանութ (կեղծ՝ 1)",
    "• Տվյալների որակ՝ 72/100",
  ]);
  const empty = summaryBullets({ share: { now: { shops: 0 } }, mover: null, drops: [], flagged: { total: 0, fake: 0 }, quality: { score: null } });
  assert.deepEqual(empty.split("\n"), ["• Դարակի թարմ տվյալ չկա", "• Մրցակցի գների զգալի անկում չկա"]);
});

test("the mover: biggest change of a competitor's numeric share; Castrol and sister brands never", () => {
  const d = (brands) => ({ shops: 10, brands: brands.map(([key, numeric_pct]) => ({ key, numeric_pct })) });
  const now = d([["castrol", 90], ["mobil", 30], ["shell", 20]]);
  const before = d([["castrol", 10], ["mobil", 40], ["shell", 14], ["zic", 5]]);
  assert.deepEqual(biggestMover(now, before, (k) => k.toUpperCase()), { key: "mobil", name: "MOBIL", now_pct: 30, change: -10 });
  assert.equal(biggestMover(now, { shops: 0, brands: [] }), null);
});
