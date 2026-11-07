// Reads the Purchase_IN sheet out of the owner's Castrol workbook (an .xlsx the accountant uploads on the Purchases screen, owner 2026-11-07:
// "I don't see the already bought products data" -- the bot that normally sends these rows was not yet deployed). The result has exactly the
// shape of the bot's push (castrol_ceo_report work/sync_field_visits.py build_purchase_lines), so applyExcelPurchases (purchases.js) stores
// both the same way and the Excel copy is replaced whole.
import ExcelJS from "exceljs";
import { PurchaseError } from "./purchases.js";

const SHEET = "purchase_in";
// header text (lower case, letters and digits only) -> field
const HEADERS = {
  invoiceid: "invoice_id", invoiceno: "invoice_id", invoice: "invoice_id",
  date: "date",
  supplier: "supplier",
  productid: "product_id",
  brand: "brand",
  productname: "product_name",
  size: "size_l",
  qty: "qty", quantity: "qty",
  costusd: "cost_usd",
  sumamd: "amount_amd",
  info: "info",
};
const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// a cell's value: a formula's result, rich text as plain text, an error cell (#N/A) as nothing
function plain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("result" in v) return plain(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("");
    if ("error" in v) return null;
    if ("text" in v) return String(v.text);
    return null;
  }
  return v;
}
const text = (v) => {
  const x = plain(v);
  if (x === null || x === "") return null;
  if (typeof x === "number" && Number.isInteger(x)) return String(x);
  return String(x instanceof Date ? x.toISOString().slice(0, 10) : x).trim() || null;
};
const num = (v) => {
  const x = plain(v);
  if (x === null || x === "" || x instanceof Date) return null;
  const n = typeof x === "number" ? x : Number(String(x).replace(/[\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
};
// a real calendar day or nothing (31.02.2026 and 2026-13-01 are not days: the row is skipped, the import goes on)
function real(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null;
}
function day(v) {
  const x = plain(v);
  if (x instanceof Date && !Number.isNaN(x.getTime())) return real(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
  if (typeof x === "number" && x > 20000 && x < 80000) {
    const t = new Date(Math.round((x - 25569) * 86400000)); // an Excel serial date
    return real(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  const m = String(x ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return real(Number(m[1]), Number(m[2]), Number(m[3]));
  const d = String(x ?? "").trim().match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/); // 17.09.2026 (day first, as the workbook writes it)
  return d ? real(Number(d[3]), Number(d[2]), Number(d[1])) : null;
}

/** The Purchase_IN rows of an .xlsx (a Buffer), in the bot's push shape. Throws a PurchaseError the screen can show. */
export async function parsePurchaseWorkbook(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new PurchaseError("This is not an Excel (.xlsx) file");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new PurchaseError("The Excel file could not be read");
  }
  const sheets = workbook.worksheets;
  const named = sheets.find((w) => norm(w.name) === norm(SHEET));
  // the sheet by its name; a one-sheet file (the sheet saved alone) by its columns
  const candidates = named ? [named] : sheets;
  for (const sheet of candidates) {
    for (let r = 1; r <= Math.min(6, sheet.rowCount); r++) {
      const columns = {};
      sheet.getRow(r).eachCell((cell, col) => {
        const field = HEADERS[norm(plain(cell.value))];
        if (field && columns[field] === undefined) columns[field] = col;
      });
      if (!(columns.invoice_id && columns.date && columns.qty && columns.cost_usd)) continue;
      // a sheet found by its columns (not by the name Purchase_IN) must also look like purchases: a supplier and a product beside the invoice
      if (!named && !(columns.supplier && (columns.product_id || columns.product_name))) continue;
      const rows = [];
      let skipped = 0;
      let index = 0;
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber <= r) return;
        const cell = (f) => (columns[f] ? row.getCell(columns[f]).value : null);
        if (plain(cell("invoice_id")) === null && plain(cell("date")) === null && plain(cell("qty")) === null) return; // a blank row
        index += 1;
        const date = day(cell("date"));
        const invoice = text(cell("invoice_id"));
        if (!date || !invoice) {
          skipped += 1;
          return;
        }
        rows.push({
          invoice_id: invoice,
          date,
          supplier: text(cell("supplier")),
          product_id: text(cell("product_id")),
          brand: text(cell("brand")),
          product_name: text(cell("product_name")),
          size_l: num(cell("size_l")),
          qty: num(cell("qty")),
          cost_usd: num(cell("cost_usd")),
          amount_amd: num(cell("amount_amd")),
          info: text(cell("info")),
          excel_row: index,
        });
      });
      if (!rows.length) throw new PurchaseError("The Purchase_IN sheet has no dated invoice rows");
      return { rows, skipped, sheet: sheet.name };
    }
  }
  throw new PurchaseError("Could not find the Purchase_IN sheet with the columns InvoiceID, Date, QTY and Cost USD");
}
