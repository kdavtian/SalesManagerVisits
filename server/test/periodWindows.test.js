import test from "node:test";
import assert from "node:assert/strict";
import { periodWindow, periodTimestampCondition, periodDateCondition, PERIOD_KEYS, PERIOD_PREVIOUS } from "../src/utils/periodWindows.js";

test("period windows: today / week / month / quarter / year and the previous one of each (Monday weeks, Yerevan calendar)", () => {
  const today = "2026-10-22"; // a Thursday
  const w = (k, d = today) => periodWindow(k, d);
  assert.deepEqual(w("today"), { from: "2026-10-22", to: "2026-10-22" });
  assert.deepEqual(w("yesterday"), { from: "2026-10-21", to: "2026-10-21" });
  assert.deepEqual(w("week"), { from: "2026-10-19", to: "2026-10-22" });
  assert.deepEqual(w("last_week"), { from: "2026-10-12", to: "2026-10-18" });
  assert.deepEqual(w("month"), { from: "2026-10-01", to: "2026-10-22" });
  assert.deepEqual(w("last_month"), { from: "2026-09-01", to: "2026-09-30" });
  assert.deepEqual(w("quarter"), { from: "2026-10-01", to: "2026-10-22" });
  assert.deepEqual(w("last_quarter"), { from: "2026-07-01", to: "2026-09-30" });
  assert.deepEqual(w("year"), { from: "2026-01-01", to: "2026-10-22" });
  assert.deepEqual(w("last_year"), { from: "2025-01-01", to: "2025-12-31" });
  assert.equal(w("all"), null);
  assert.equal(w("nonsense"), null);
});

test("period windows: year boundaries (January: last month / quarter / week reach into the previous year)", () => {
  const today = "2026-01-05"; // a Monday
  assert.deepEqual(periodWindow("last_week", today), { from: "2025-12-29", to: "2026-01-04" });
  assert.deepEqual(periodWindow("last_month", today), { from: "2025-12-01", to: "2025-12-31" });
  assert.deepEqual(periodWindow("last_quarter", today), { from: "2025-10-01", to: "2025-12-31" });
  assert.deepEqual(periodWindow("yesterday", "2026-03-01"), { from: "2026-02-28", to: "2026-02-28" });
  assert.deepEqual(periodWindow("last_month", "2026-03-31"), { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(periodWindow("last_quarter", "2026-03-31"), { from: "2025-10-01", to: "2025-12-31" });
  assert.deepEqual(periodWindow("quarter", "2026-06-30"), { from: "2026-04-01", to: "2026-06-30" });
});

test("every previous period has a button and every key has a window; SQL conditions push their two dates", () => {
  for (const k of PERIOD_KEYS) assert.ok(periodWindow(k, "2026-10-22"), k);
  for (const [base, prev] of Object.entries(PERIOD_PREVIOUS)) assert.ok(PERIOD_KEYS.includes(base) && PERIOD_KEYS.includes(prev));
  const params = ["x"];
  const sql = periodTimestampCondition("ch.timestamp", "last_week", params);
  assert.equal(params.length, 3);
  assert.match(sql, /ch\.timestamp >= \(\$2::date::timestamp AT TIME ZONE 'Asia\/Yerevan'\) AND ch\.timestamp < \(\(\$3::date \+ 1\)::timestamp AT TIME ZONE 'Asia\/Yerevan'\)/);
  const p2 = [];
  assert.match(periodDateCondition("cf.cashflow_date", "month", p2), /cf\.cashflow_date >= \$1::date AND cf\.cashflow_date <= \$2::date/);
  assert.equal(periodTimestampCondition("c", "all", []), null);
});
