// A cell starting with =, +, -, or @ is interpreted as a formula by Excel
// and most spreadsheet apps -- a customer or product name containing one
// (however it got there) would otherwise execute when the accountant opens
// this file. Prefixing with a tab defuses the formula while leaving the
// visible text unchanged.
const FORMULA_PREFIX = /^[=+\-@]/;

function csvCell(value) {
  let str = value == null ? "" : String(value);
  if (FORMULA_PREFIX.test(str)) str = `\t${str}`;
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }
  // A leading BOM so Excel (which guesses encoding without one) doesn't
  // mangle non-ASCII characters -- Armenian names in this app aren't rare.
  return "﻿" + lines.join("\r\n") + "\r\n";
}
