// Excel "Balance" pairs (money/excelBalanceHandoffs.js pairBalanceRows), without a database.
import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://unused/unused";
const { pairBalanceRows } = await import("../src/money/excelBalanceHandoffs.js");

const row = (id, day, amount, account) => ({ id, entry_date: day, amount_amd: amount, account_id: account, account_name: account === 1 ? "Cash DVT" : account === 2 ? "Cash" : "Cash YVN" });

test("a minus on one box and the same plus on another, same or next day, make a pair; each row is used once", () => {
  const pairs = pairBalanceRows([
    row(1, "2026-11-10", -300000, 1),
    row(2, "2026-11-11", 300000, 2), // next day
    row(3, "2026-11-12", -50000, 1),
    row(4, "2026-11-14", 50000, 2), // two days later: no pair
    row(5, "2026-11-12", -70000, 3),
    row(6, "2026-11-12", 70000, 3), // same box: not a hand-over
  ]);
  assert.deepEqual(pairs.map((p) => [p.from.id, p.to.id, p.amount, p.day]), [[1, 2, 300000, "2026-11-10"]]);
  assert.equal(pairs[0].key, "2026-11-10|300000|cash dvt|cash|1");
});

test("two identical hand-overs on one day get their own keys (a re-upload finds the same two)", () => {
  const rows = [row(1, "2026-11-10", -10000, 1), row(2, "2026-11-10", 10000, 2), row(3, "2026-11-10", -10000, 1), row(4, "2026-11-10", 10000, 2)];
  const keys = pairBalanceRows(rows).map((p) => p.key);
  assert.deepEqual(keys, ["2026-11-10|10000|cash dvt|cash|1", "2026-11-10|10000|cash dvt|cash|2"]);
  // the same rows uploaded again with new ids -> the same keys
  assert.deepEqual(pairBalanceRows(rows.map((r) => ({ ...r, id: r.id + 100 }))).map((p) => p.key), keys);
});
