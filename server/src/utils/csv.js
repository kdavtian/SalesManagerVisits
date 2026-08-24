function csvCell(value) {
  const str = value == null ? "" : String(value);
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
