// The company's days-of-stock model (src/products/demandModel.js): weighted weekly demand, outlier damping, Croston for lumpy sales,
// safety stock and reorder point, free stock after open orders.
import test from "node:test";
import assert from "node:assert/strict";
import { computeDemandForecast, winsorize, bucketWeeks, MODEL } from "../src/products/demandModel.js";

const today = "2026-11-03";
const steady = (n) => Array(MODEL.weeks).fill(n); // n pieces every week
const base = { today, lastSaleDate: "2026-11-01", createdAt: "2025-01-01" };

test("steady sales: 14 a week = 2 a day; days left = free stock / daily demand", () => {
  const f = computeDemandForecast({ ...base, weeklyQty: steady(14), stockQty: 200 });
  assert.equal(f.method, "ewma");
  assert.ok(Math.abs(f.dailyDemand - 2) < 1e-9);
  assert.ok(Math.abs(f.daysOfStock - 100) < 1e-6);
  assert.equal(f.safetyStock, 0, "no variability, no safety stock");
  assert.equal(f.reorderPoint, 90); // 2/day x 45 days
  assert.equal(f.status, "ok");
  assert.equal(f.variability, "X");
});

test("reserved stock is not free to sell", () => {
  const f = computeDemandForecast({ ...base, weeklyQty: steady(14), stockQty: 200, reservedQty: 150 });
  assert.equal(f.freeStock, 50);
  assert.ok(Math.abs(f.daysOfStock - 25) < 1e-6);
  assert.equal(f.status, "critical", "50 free is under the reorder point of 90");
});

test("recent weeks count more: a product that doubled lately is forecast above its flat average", () => {
  const rising = [...Array(6).fill(28), ...Array(20).fill(14)]; // newest 6 weeks double
  const f = computeDemandForecast({ ...base, weeklyQty: rising, stockQty: 500 });
  const flatAvg = (6 * 28 + 20 * 14) / 26 / 7;
  assert.ok(f.dailyDemand > flatAvg, `${f.dailyDemand} > ${flatAvg}`);
  assert.equal(f.trend, "up");
});

test("one huge one-off week is damped, a lasting change is not", () => {
  const spike = steady(10);
  spike[3] = 400;
  const damped = winsorize(spike);
  assert.ok(Math.max(...damped) < 40, `the 400 spike is capped, got ${Math.max(...damped)}`);
  const f = computeDemandForecast({ ...base, weeklyQty: spike, stockQty: 1000 });
  assert.ok(f.dailyDemand < 10 / 7 + 0.6, "the spike does not make it a bestseller");
  const shift = [...Array(13).fill(40), ...Array(13).fill(10)]; // half the series at a new level
  const g = computeDemandForecast({ ...base, weeklyQty: shift, stockQty: 1000 });
  assert.ok(g.dailyDemand > 10 / 7 + 0.5, "a real level change moves it");
});

test("lumpy sales use Croston (a sale every ~5 weeks), not an average that swings", () => {
  const lumpy = Array(MODEL.weeks).fill(0);
  [1, 6, 11, 16, 21].forEach((w) => (lumpy[w] = 20));
  const f = computeDemandForecast({ ...base, weeklyQty: lumpy, stockQty: 100 });
  assert.equal(f.method, "croston");
  assert.equal(f.variability, "Z");
  const weekly = f.dailyDemand * 7;
  assert.ok(weekly > 2.5 && weekly < 5, `about 20 per 5 weeks, got ${weekly}`);
});

test("variable sales get a safety stock; the reorder point is demand x lead time + safety stock", () => {
  const wavy = Array.from({ length: MODEL.weeks }, (_, i) => (i % 2 ? 4 : 24));
  const f = computeDemandForecast({ ...base, weeklyQty: wavy, stockQty: 400 });
  assert.ok(f.safetyStock > 0);
  assert.equal(f.reorderPoint, Math.ceil(f.dailyDemand * MODEL.leadTimeDays + f.safetyStock - 1e-9));
});

test("statuses: unknown, out, new, dead, slow", () => {
  assert.equal(computeDemandForecast({ ...base, weeklyQty: [], stockQty: null }).status, "unknown");
  assert.equal(computeDemandForecast({ ...base, weeklyQty: steady(5), stockQty: 0 }).status, "out");
  assert.equal(computeDemandForecast({ today, lastSaleDate: null, createdAt: "2026-10-20", weeklyQty: [], stockQty: 10 }).status, "new");
  assert.equal(computeDemandForecast({ today, lastSaleDate: null, createdAt: "2025-01-01", weeklyQty: [], stockQty: 10 }).status, "dead");
  assert.equal(computeDemandForecast({ today, lastSaleDate: "2026-01-01", createdAt: "2025-01-01", weeklyQty: [], stockQty: 10 }).status, "dead");
  // sold within 180 days but nothing in the 26 weeks window with data: slow
  assert.equal(computeDemandForecast({ today, lastSaleDate: "2026-06-01", createdAt: "2025-01-01", weeklyQty: [], stockQty: 10 }).status, "slow");
});

test("bucketWeeks groups rows per product and ignores weeks outside the window", () => {
  const m = bucketWeeks([{ product_id: "A", wk: 0, qty: 3 }, { product_id: "A", wk: 0, qty: 2 }, { product_id: "A", wk: 25, qty: 1 }, { product_id: "A", wk: 26, qty: 9 }, { product_id: "B", wk: 1, qty: 4 }]);
  assert.equal(m.get("A")[0], 5);
  assert.equal(m.get("A")[25], 1);
  assert.equal(m.get("A").length, MODEL.weeks);
  assert.equal(m.get("B")[1], 4);
});

test("one lump order is a one-off, not daily demand; a product that only just started selling is not averaged with empty weeks", () => {
  const lump = Array(MODEL.weeks).fill(0);
  lump[0] = 60; // one 60-piece order this week
  const f = computeDemandForecast({ ...base, weeklyQty: lump, stockQty: 100 });
  assert.ok(f.dailyDemand * 7 < 10, `60 pieces once is far less than 60 a week, got ${f.dailyDemand * 7} a week`);
  const fresh = Array(MODEL.weeks).fill(0);
  for (let w = 0; w < 13; w++) fresh[w] = 15; // sells 15 a week for 13 weeks, nothing before
  const g = computeDemandForecast({ ...base, weeklyQty: fresh, stockQty: 100 });
  assert.ok(Math.abs(g.dailyDemand - 15 / 7) < 0.05, `about 2.14 a day, got ${g.dailyDemand}`);
});
