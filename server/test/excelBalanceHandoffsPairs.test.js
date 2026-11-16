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
  assert.equal(pairs[0].key, "2026-11-10|300000|1|2|1", "box ids, not names: a renamed box keeps its pairs");
});

test("two identical hand-overs on one day get their own keys (a re-upload finds the same two)", () => {
  const rows = [row(1, "2026-11-10", -10000, 1), row(2, "2026-11-10", 10000, 2), row(3, "2026-11-10", -10000, 1), row(4, "2026-11-10", 10000, 2)];
  const keys = pairBalanceRows(rows).map((p) => p.key);
  assert.deepEqual(keys, ["2026-11-10|10000|1|2|1", "2026-11-10|10000|1|2|2"]);
  // the same rows uploaded again with new ids -> the same keys
  assert.deepEqual(pairBalanceRows(rows.map((r) => ({ ...r, id: r.id + 100 }))).map((p) => p.key), keys);
});

test("a rep's outflow takes the office inflow first, even when another box got the same amount earlier the same day", () => {
  // rep -100k, Bank +100k (lower id), Cash +100k, Cash -100k: without the preference the rep's row would pair with the Bank and be lost
  const rows = [row(1, "2026-11-10", -100000, 1), { ...row(2, "2026-11-10", 100000, 9), account_name: "Bank" }, row(3, "2026-11-10", 100000, 2), row(4, "2026-11-10", -100000, 2)];
  const pairs = pairBalanceRows(rows, { prefer: (out, inflow) => out.account_id === 1 && inflow.account_id === 2 });
  assert.deepEqual(pairs.map((p) => [p.from.id, p.to.id]), [[1, 3], [4, 2]]);
});
