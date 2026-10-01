import test from "node:test";
import assert from "node:assert/strict";
import { computeStockForecast, DEAD_STOCK_DAYS, CRITICAL_DAYS_THRESHOLD, LOW_DAYS_THRESHOLD } from "../src/stockForecast.js";

const TODAY = "2026-06-30";

function daysAgo(n) {
  const d = new Date(Date.UTC(2026, 5, 30));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

test("computeStockForecast: null stock_qty is 'unknown', not an estimate", () => {
  const r = computeStockForecast({ stockQty: null, qty30d: 10, qty90d: 30, lastSaleDate: daysAgo(1), createdAt: daysAgo(400), today: TODAY });
  assert.equal(r.status, "unknown");
  assert.equal(r.dailyDemand, null);
  assert.equal(r.daysOfStock, null);
});

test("computeStockForecast: zero stock is 'out' with daysOfStock 0, regardless of demand", () => {
  const r = computeStockForecast({ stockQty: 0, qty30d: 50, qty90d: 150, lastSaleDate: daysAgo(1), createdAt: daysAgo(400), today: TODAY });
  assert.equal(r.status, "out");
  assert.equal(r.daysOfStock, 0);
});

test("computeStockForecast: never sold, created recently -> 'new', not 'dead'", () => {
  const r = computeStockForecast({ stockQty: 20, qty30d: 0, qty90d: 0, lastSaleDate: null, createdAt: daysAgo(10), today: TODAY });
  assert.equal(r.status, "new");
  assert.equal(r.dailyDemand, null);
});

test("computeStockForecast: never sold, created long ago -> 'dead'", () => {
  const r = computeStockForecast({ stockQty: 20, qty30d: 0, qty90d: 0, lastSaleDate: null, createdAt: daysAgo(400), today: TODAY });
  assert.equal(r.status, "dead");
  assert.equal(r.dailyDemand, 0);
});

test(`computeStockForecast: last sale older than DEAD_STOCK_DAYS (${DEAD_STOCK_DAYS}) is 'dead' even with old window qty`, () => {
  const r = computeStockForecast({ stockQty: 20, qty30d: 0, qty90d: 0, lastSaleDate: daysAgo(DEAD_STOCK_DAYS + 1), createdAt: daysAgo(900), today: TODAY });
  assert.equal(r.status, "dead");
  assert.equal(r.dailyDemand, 0);
  assert.equal(r.daysOfStock, null);
});

test("computeStockForecast: sold within 180 days but nothing in the last 90 -> 'slow', no days-left number", () => {
  const r = computeStockForecast({ stockQty: 20, qty30d: 0, qty90d: 0, lastSaleDate: daysAgo(100), createdAt: daysAgo(900), today: TODAY });
  assert.equal(r.status, "slow");
  assert.equal(r.daysOfStock, null);
});

test("computeStockForecast: steady demand lands in the right threshold band (critical/low/ok)", () => {
  // 1 unit/day blended (30d and 90d windows agree -- no trend): stock of 5
  // is under CRITICAL_DAYS_THRESHOLD, 15 is under LOW but not critical, 30
  // is 'ok'.
  const base = { qty30d: 30, qty90d: 90, lastSaleDate: daysAgo(1), createdAt: daysAgo(900), today: TODAY };
  const critical = computeStockForecast({ ...base, stockQty: 5 });
  assert.equal(critical.status, "critical");
  assert.ok(critical.daysOfStock < CRITICAL_DAYS_THRESHOLD);

  const low = computeStockForecast({ ...base, stockQty: 15 });
  assert.equal(low.status, "low");
  assert.ok(low.daysOfStock >= CRITICAL_DAYS_THRESHOLD && low.daysOfStock < LOW_DAYS_THRESHOLD);

  const ok = computeStockForecast({ ...base, stockQty: 30 });
  assert.equal(ok.status, "ok");
  assert.ok(ok.daysOfStock >= LOW_DAYS_THRESHOLD);
  assert.equal(ok.trend, "flat");
});

test("computeStockForecast: demand trending up pulls the blended rate above the 90-day baseline", () => {
  // 90-day baseline: 0.5/day (45 over 90). 30-day recent: 2/day (60 over
  // 30) -- a clear recent acceleration.
  const r = computeStockForecast({ stockQty: 100, qty30d: 60, qty90d: 45, lastSaleDate: daysAgo(1), createdAt: daysAgo(900), today: TODAY });
  assert.equal(r.trend, "up");
  // Blended: 0.6*2 + 0.4*0.5 = 1.4/day -- strictly above the flat 0.5/day
  // baseline rate, so days-left is shorter than a plain 90-day average
  // would say (100 / 0.5 = 200 days) would claim.
  assert.ok(r.dailyDemand > 0.5);
  assert.ok(r.daysOfStock < 100 / 0.5);
});

test("computeStockForecast: demand trending down pulls the blended rate below the 90-day baseline", () => {
  // 90-day baseline: 1/day (90 over 90). 30-day recent: 0.2/day (6 over 30).
  const r = computeStockForecast({ stockQty: 100, qty30d: 6, qty90d: 90, lastSaleDate: daysAgo(1), createdAt: daysAgo(900), today: TODAY });
  assert.equal(r.trend, "down");
  assert.ok(r.dailyDemand < 1);
});

test("computeStockForecast: dailyDemand is a straight 0.6/0.4 blend of the two windows' own daily rates", () => {
  const r = computeStockForecast({ stockQty: 1000, qty30d: 30, qty90d: 180, lastSaleDate: daysAgo(1), createdAt: daysAgo(900), today: TODAY });
  const expected = 0.6 * (30 / 30) + 0.4 * (180 / 90);
  assert.ok(Math.abs(r.dailyDemand - expected) < 1e-9);
  assert.ok(Math.abs(r.daysOfStock - 1000 / expected) < 1e-9);
});
