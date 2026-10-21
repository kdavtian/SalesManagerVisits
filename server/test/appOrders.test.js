// KAD OS app-order rules (server/src/appOrders.js): delivery promise, campaign pricing, app discount, statuses, levels and streak.
import "dotenv/config"; // appOrders.js imports db/pool.js, which needs DATABASE_URL at import time
import test from "node:test";
import assert from "node:assert/strict";
import {
  computePromisedDate, applyCampaigns, appDiscountAmd, partnerStatus, levelProgress, streakWeeks, validateSettingsPatch, normalizeSettings, APP_ORDER_DEFAULTS,
} from "../src/appOrders.js";

// 2026-10-21 is a Wednesday. Yerevan is UTC+4, so 08:00Z = 12:00 local, 12:00Z = 16:00 local.
const at = (iso) => new Date(iso);
const s = (days, cutoff = 15) => ({ promise_working_days: days, promise_cutoff_hour: cutoff });

test("delivery promise: before the cut-off counts from today, after it from the next working day", () => {
  assert.equal(computePromisedDate(at("2026-10-21T08:00:00Z"), s(1)), "2026-10-22"); // Wed noon + 1 working day
  assert.equal(computePromisedDate(at("2026-10-21T12:00:00Z"), s(1)), "2026-10-23"); // Wed 16:00 is after 15:00 -> starts Thursday
  assert.equal(computePromisedDate(at("2026-10-21T08:00:00Z"), s(0)), "2026-10-21"); // 0 days = the same working day
  assert.equal(computePromisedDate(at("2026-10-21T12:00:00Z"), s(0)), "2026-10-22");
});

test("delivery promise: Sunday and holidays never count", () => {
  // Saturday 2026-10-24 noon + 1 working day: Sunday is skipped -> Monday 26th... Saturday is a working day, so Sat + 1 = Monday.
  assert.equal(computePromisedDate(at("2026-10-24T08:00:00Z"), s(1)), "2026-10-26");
  // Sunday order starts Monday.
  assert.equal(computePromisedDate(at("2026-10-25T08:00:00Z"), s(1)), "2026-10-27");
  // A holiday on Thursday 22nd pushes Wed + 1 to Friday.
  assert.equal(computePromisedDate(at("2026-10-21T08:00:00Z"), s(1), new Set(["2026-10-22"])), "2026-10-23");
});

const line = (product_id, quantity, price) => ({ product_id, quantity, unit_price_amd: price, line_total_amd: price * quantity });
const camp = (id, kind, percent, products) => ({ id, kind, percent, products: products.map(([product_id, min_qty]) => ({ product_id, min_qty })) });

test("campaigns: a discount campaign prices only the listed lines that reach min_qty", () => {
  const out = applyCampaigns([line(1, 3, 10000), line(2, 1, 5000)], [camp(7, "discount", 10, [[1, 2], [2, 2]])]);
  assert.equal(out[0].unit_price_amd, 9000);
  assert.equal(out[0].list_price_amd, 10000);
  assert.equal(out[0].line_total_amd, 27000);
  assert.equal(out[0].campaign_id, 7);
  assert.equal(out[1].campaign_id, null, "qty 1 < min_qty 2");
  assert.equal(out[1].unit_price_amd, 5000);
});

test("campaigns: a bundle needs EVERY listed product; the best percent wins; prices are whole AMD", () => {
  const bundle = camp(8, "bundle", 5, [[1, 4], [2, 2]]);
  assert.equal(applyCampaigns([line(1, 4, 10000)], [bundle])[0].campaign_id, null, "one product of two");
  assert.equal(applyCampaigns([line(1, 3, 10000), line(2, 2, 3000)], [bundle])[0].campaign_id, null, "first product under its min");
  const both = applyCampaigns([line(1, 4, 10000), line(2, 2, 3333)], [bundle]);
  assert.deepEqual(both.map((l) => l.campaign_id), [8, 8]);
  assert.equal(both[1].unit_price_amd, 3166, "3333 * 0.95 = 3166.35 -> 3166");
  const best = applyCampaigns([line(1, 4, 10000), line(2, 2, 3000)], [bundle, camp(9, "discount", 12, [[1, 1]])]);
  assert.equal(best[0].campaign_id, 9);
  assert.equal(best[0].unit_price_amd, 8800);
  assert.equal(best[1].campaign_id, 8, "the other product keeps the bundle");
});

test("app discount: flat AMD on the lines no campaign covers, never stacked, floored to whole AMD", () => {
  const priced = applyCampaigns([line(1, 2, 10000), line(2, 1, 3333)], [camp(7, "discount", 10, [[1, 1]])]);
  assert.equal(appDiscountAmd(priced, 2), Math.floor((3333 * 2) / 100)); // only product 2 counts: 66
  assert.equal(appDiscountAmd(priced, 0), 0);
  assert.equal(appDiscountAmd([line(1, 2, 10000)], 2), 400);
});

test("statuses: received -> confirmed -> packed -> on the way -> delivered; a returned draft is on hold", () => {
  assert.equal(partnerStatus("submitted", false), "received");
  assert.equal(partnerStatus("confirmed", false), "confirmed");
  assert.equal(partnerStatus("packed_stock_out", false), "packed");
  assert.equal(partnerStatus("packed_stock_out", true), "on_the_way");
  assert.equal(partnerStatus("delivered", true), "delivered");
  assert.equal(partnerStatus("draft", false), "on_hold");
});

test("levels: thresholds per month, percent towards the next one, top level at 100 %", () => {
  const lv = [1, 3, 6, 10];
  assert.deepEqual(levelProgress(0, lv), { level: 0, orders_this_month: 0, next_level: 1, next_at: 1, remaining: 1, pct: 0 });
  const two = levelProgress(2, lv);
  assert.equal(two.level, 1);
  assert.equal(two.next_at, 3);
  assert.equal(two.remaining, 1);
  assert.equal(two.pct, 50);
  assert.equal(levelProgress(10, lv).level, 4);
  assert.equal(levelProgress(10, lv).pct, 100);
  assert.equal(levelProgress(10, lv).next_at, null);
});

test("streak: consecutive weeks with an app order; this week may still be empty", () => {
  assert.deepEqual(streakWeeks(["2026-10-12", "2026-10-05", "2026-09-28"], "2026-10-19"), { weeks: 3, active_this_week: false });
  assert.deepEqual(streakWeeks(["2026-10-19", "2026-10-12", "2026-09-28"], "2026-10-19"), { weeks: 2, active_this_week: true });
  assert.deepEqual(streakWeeks(["2026-09-28"], "2026-10-19"), { weeks: 0, active_this_week: false });
});

test("settings: defaults match the owner's choices (flat 2 %, priority, promise); a patch is validated", () => {
  assert.equal(APP_ORDER_DEFAULTS.discount_pct, 2);
  assert.equal(normalizeSettings({}).priority_enabled, true);
  assert.equal(normalizeSettings({ discount_pct: 3 }).discount_pct, 3);
  assert.deepEqual(validateSettingsPatch({ discount_pct: 3, promise_working_days: 1 }).value, { discount_pct: 3, promise_working_days: 1 });
  for (const bad of [{ discount_pct: 11 }, { discount_pct: -1 }, { discount_enabled: "yes" }, { promise_working_days: 1.5 }, { promise_cutoff_hour: 24 }, { levels: [1, 3, 3, 10] }, { levels: [1, 2, 3] }]) {
    assert.ok(validateSettingsPatch(bad).error, JSON.stringify(bad));
  }
});
