// Bank statement reading and matching (server/src/money/bankStatement.js): no database needed.
import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseAmount, readStatement, hashLines, matchLines } from "../src/money/bankStatement.js";

test("amounts: thousands separators, decimal comma, brackets and trailing minus", () => {
  assert.equal(parseAmount("1,234.56"), 1234.56);
  assert.equal(parseAmount("1.234,56"), 1234.56);
  assert.equal(parseAmount("1 234,5"), 1234.5);
  assert.equal(parseAmount("(1,000)"), -1000);
  assert.equal(parseAmount("-2,500"), -2500);
  assert.equal(parseAmount("2,500-"), -2500);
  assert.equal(parseAmount("12,345"), 12345, "a comma followed by three digits is a thousands separator");
  assert.equal(parseAmount("+500"), 500);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("abc"), null);
});

test("csv: semicolons, quoted cells with the delimiter and doubled quotes, BOM-free text", () => {
  const rows = parseCsv('Date;Details;Amount\n01.10.2026;"Pay; for ""oil"""; -1 000,50\n');
  assert.deepEqual(rows[1], ["01.10.2026", 'Pay; for "oil"', "-1 000,50"]);
});

test("statement with one Amount column: header row found below a title, dd.mm.yyyy dates, signs kept", async () => {
  const csv = ["Account statement;;", "Account: 1234;;", "Date;Description;Amount;Balance", "01.10.2026;Customer payment;150 000,00;1 150 000,00", "02.10.2026;Fuel;-20 000,00;1 130 000,00", ";;;"].join("\n");
  const r = await readStatement(Buffer.from(csv), "stmt.csv");
  assert.equal(r.needsMapping, false);
  assert.deepEqual(r.lines.map((l) => [l.line_date, l.amount, l.description]), [["2026-10-01", 150000, "Customer payment"], ["2026-10-02", -20000, "Fuel"]]);
  assert.equal(r.lines[0].balance, 1150000);
});

test("statement with Debit / Credit columns (Armenian and English headers) and a currency column", async () => {
  const csv = ["Ամսաթիվ,Նկարագրություն,Դեբետ,Կրեդիտ,Արժույթ", "2026-10-03,Վճարում,5000,,AMD", "2026-10-04,Մուտք,,12000.5,AMD", "2026-10-05,Euro line,1,,EUR", "2026-10-06,Dollars,,100,USD"].join("\n");
  const r = await readStatement(Buffer.from(csv), "x.csv");
  assert.deepEqual(r.lines.map((l) => [l.amount, l.currency]), [[-5000, "AMD"], [12000.5, "AMD"], [100, "USD"]]);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /EUR/);
});

test("a file with no recognisable header asks for the column mapping, and a mapping reads it", async () => {
  const csv = ["foo;bar;baz", "2026-10-01;abc;100", "2026-10-02;def;-50"].join("\n");
  const first = await readStatement(Buffer.from(csv), "x.csv");
  assert.equal(first.needsMapping, true);
  const mapped = await readStatement(Buffer.from(csv), "x.csv", { mapping: { date: 0, description: 1, amount: 2 } });
  assert.deepEqual(mapped.lines.map((l) => l.amount), [100, -50]);
});

test("line hashes: stable for the same file, identical lines inside one file stay distinct", () => {
  const l = { line_date: "2026-10-01", amount: -100, currency: "AMD", description: "x" };
  const a = hashLines(7, [l, l, { ...l, amount: -5 }]);
  assert.equal(new Set(a).size, 3);
  assert.deepEqual(hashLines(7, [l, l, { ...l, amount: -5 }]), a);
  assert.notEqual(hashLines(8, [l])[0], hashLines(7, [l])[0], "another account is another line");
});

test("matching: same amount and currency within 3 days, nearest first, every ledger row used once", () => {
  const lines = [
    { id: 1, date: "2026-10-10", amount: -1000, currency: "AMD" },
    { id: 2, date: "2026-10-10", amount: -1000, currency: "AMD" },
    { id: 3, date: "2026-10-10", amount: 500, currency: "AMD" },
    { id: 4, date: "2026-10-10", amount: 100, currency: "USD" },
  ];
  const entries = [
    { id: 10, date: "2026-10-12", amount: -1000, currency: "AMD" },
    { id: 11, date: "2026-10-10", amount: -1000, currency: "AMD" },
    { id: 12, date: "2026-10-20", amount: 500, currency: "AMD" }, // too far
    { id: 13, date: "2026-10-10", amount: 100, currency: "AMD" }, // wrong currency
  ];
  const m = matchLines(lines, entries);
  assert.equal(m.get(1), 11, "the exact date wins");
  assert.equal(m.get(2), 10, "the second equal line takes the next row");
  assert.equal(m.has(3), false);
  assert.equal(m.has(4), false);
});
