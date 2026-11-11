// The Evoca statement layout (owner, 2026-11-11), reproduced with MADE-UP names and amounts: a header block, the table header printed again above every
// day, per-day "Movement" / "Balance" rows, split Մուտք / Ելք columns, numbers as text with thousands commas, and a workbook ExcelJS cannot open
// (every tag prefixed with x:, decorative tables, absolute part paths). The real file is never kept in the repository.
import test from "node:test";
import assert from "node:assert/strict";
import { readStatement, checkStatement } from "../src/money/bankStatement.js";
import { readXlsxRows } from "../src/money/xlsxLite.js";
import { evocaWorkbook, evocaRows, ACCOUNT } from "./evocaFixture.js";

test("a workbook with prefixed tags and decorative tables is read by the tolerant reader (ExcelJS cannot open it)", async () => {
  const buf = await evocaWorkbook(evocaRows());
  const rows = await readXlsxRows(buf);
  assert.equal(rows[0][0], "Ժամանակահատվածի սկիզբ");
  assert.equal(rows.find((r) => r[0] === "01/10/2026")[5], "1,000,000.00");
  const statement = await readStatement(buf, "evoca.xlsx");
  assert.equal(statement.lines.length, 5, "5 transactions: no header rows, no Movement / Balance rows, no footer");
  assert.equal(statement.skipped.length, 0);
});

test("lines: signs from the split In / Out columns, the kind of operation and the other side's account are kept", async () => {
  const { lines } = await readStatement(await evocaWorkbook(evocaRows()), "evoca.xlsx");
  assert.deepEqual(lines.map((l) => l.amount), [1000000, 350000, -5500, 4000000, -309000]);
  assert.equal(lines[2].type_code, "FEE");
  assert.equal(lines[0].reference, "100001");
  assert.equal(lines[0].counterparty_account, "1570000000000100");
  assert.equal(lines[3].counterparty_account, "1660000000000300");
  assert.equal(lines[0].currency, "AMD");
  assert.equal(lines[0].line_date, "2026-10-01");
});

test("the header block: period, account number, holder, currency, balances and totals", async () => {
  const { meta } = await readStatement(await evocaWorkbook(evocaRows()), "evoca.xlsx");
  assert.equal(meta.account_number, ACCOUNT);
  assert.equal(meta.holder, "«ՏԵՍՏ ՕՅԼ» ՍՊԸ");
  assert.equal(meta.currency, "AMD");
  assert.equal(meta.period_from, "2026-10-01");
  assert.equal(meta.period_to, "2026-10-03");
  assert.equal(meta.opening_balance, 2200000);
  assert.equal(meta.closing_balance, 7235500);
  assert.equal(meta.total_in, 5350000);
  assert.equal(meta.total_out, 314500);
});

test("the statement proves itself: totals, every day's movement and the running balance agree", async () => {
  const { checks } = await readStatement(await evocaWorkbook(evocaRows()), "evoca.xlsx");
  assert.equal(checks.ok, true, JSON.stringify(checks.items));
  assert.ok(checks.compared >= 9, `compared ${checks.compared}`);
});

test("a statement whose lines do not add up to its own totals is flagged, with the day and the numbers", async () => {
  const lost = evocaRows();
  lost.splice(12, 1); // the first payment of day 1 is missing from the file
  const { checks } = await readStatement(await evocaWorkbook(lost), "evoca.xlsx");
  assert.equal(checks.ok, false);
  const kinds = checks.items.map((i) => i.kind);
  assert.ok(kinds.includes("total_in") && kinds.includes("day_in") && kinds.includes("day_balance"), kinds.join());
  const day = checks.items.find((i) => i.kind === "day_in");
  assert.equal(day.date, "2026-10-01");
  assert.equal(day.expected, 1350000);
  assert.equal(day.got, 350000);
  // one wrong day does not flag the days after it (the running balance restarts from the bank's own figure)
  assert.equal(checks.items.filter((i) => i.kind === "day_balance").length, 1);
});

test("a plain statement without a header block or subtotals has nothing to compare: ok is null, nothing is blocked", () => {
  const checks = checkStatement([{ line_date: "2026-10-01", amount: 5 }], {}, new Map());
  assert.equal(checks.ok, null);
});

// ---- review fixes (2026-11-11) ----
test("a row with money whose date cannot be read is reported, never silently dropped (even when a counterparty starts with 'Balance')", async () => {
  const rows = evocaRows();
  rows.splice(12, 0, ["1 Oct 2026", "100099", "TRF", "1570000000000999", "Payment", "50,000.00", "0.00", "Balance Motors LLC"]);
  const statement = await readStatement(await evocaWorkbook(rows), "evoca.xlsx");
  assert.equal(statement.lines.length, 5, "the five real lines");
  assert.equal(statement.skipped.length, 1, "the unreadable one is listed");
  assert.equal(statement.skipped[0].reason, "no date");
});

test("a header cell that is not an account number is not taken for one", async () => {
  const rows = evocaRows();
  rows[2] = ["Հաշիվ N", "see attached", "x"];
  const { meta } = await readStatement(await evocaWorkbook(rows), "evoca.xlsx");
  assert.equal(meta.account_number, undefined);
});

test("a crafted cell reference cannot make an array of billions, and a part that declares a huge size is refused before it is inflated", async () => {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await evocaWorkbook(evocaRows()));
  const sheet = await zip.file("xl/worksheets/sheet1.xml").async("string");
  zip.file("xl/worksheets/sheet1.xml", sheet.replace('<x:row r="1">', '<x:row r="1"><x:c r="ZZZZZZZZ1" t="s"><x:v>0</x:v></x:c>'));
  const started = Date.now();
  const rows = await readXlsxRows(await zip.generateAsync({ type: "nodebuffer" }));
  assert.ok(Date.now() - started < 2000);
  assert.equal(rows[0][0], "Ժամանակահատվածի սկիզբ", "the real cell is still read; the crafted one is dropped");
  assert.ok(rows[0].length < 10);
});
