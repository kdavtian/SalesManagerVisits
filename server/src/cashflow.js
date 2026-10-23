// Cashflow module (owner, 2026-10-23): the Excel Cashflow sheet (table `Cash`) as a ledger in the app.
// This file: reading the sheet from a workbook, normalising its rows, and replacing the Excel-origin part of the ledger.
// Manual rows (origin = 'manual' / 'bank') are never touched by a refresh.
import ExcelJS from "exceljs";
import { pool } from "./db/pool.js";

export const CASH_COLUMNS = ["date", "amount", "currency", "for", "id", "source", "info", "customer_name", "currency_rate", "amount_amd", "sales_rep", "transaction_id"];

const norm = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const HEADER_ALIASES = {
  date: ["date"],
  amount: ["amount"],
  currency: ["currency"],
  for: ["for"],
  id: ["id"],
  source: ["source"],
  info: ["info"],
  currency_rate: ["currency rate", "rate"],
  amount_amd: ["amount amd"],
  sales_rep: ["sales rep"],
  transaction_id: ["transactionid", "transaction id"],
};

// A cell value as exceljs gives it: a formula cell is { formula, result }, a date is a Date, rich text has .richText.
function cellValue(cell) {
  let v = cell?.value;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) v = v.result;
    else if ("richText" in v) v = v.richText.map((r) => r.text).join("");
    else if ("text" in v) v = v.text;
  }
  if (v && typeof v === "object" && !(v instanceof Date)) return null; // an error cell (#REF! ...)
  return v ?? null;
}

export function ymd(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(String(value ?? "").trim());
  return d ? `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}` : null;
}

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const text = (v) => {
  const s = String(v ?? "").trim();
  return s || null;
};

// One raw row (keys = CASH_COLUMNS) -> a clean ledger row, or { skip: reason }.
export function normalizeCashRow(raw) {
  const date = ymd(raw.date);
  const amount = num(raw.amount);
  if (!date) return { skip: "no date" };
  if (amount === null) return { skip: "no amount" };
  const currency = String(raw.currency ?? "AMD").trim().toUpperCase() === "USD" ? "USD" : "AMD";
  const rate = num(raw.currency_rate);
  let amountAmd = num(raw.amount_amd);
  if (amountAmd === null) amountAmd = currency === "USD" ? Math.round(amount * (rate ?? 0)) : amount;
  const category = text(raw.for);
  const idText = text(raw.id);
  const isCustomerId = category && category.toLowerCase() === "oil order" && idText && /^\d+$/.test(idText);
  return {
    date,
    amount,
    currency,
    fx_rate: currency === "USD" ? rate : null,
    amount_amd: Math.round(amountAmd * 100) / 100,
    category,
    account: text(raw.source),
    erp_customer_id: isCustomerId ? idText : null,
    ref: isCustomerId ? null : idText,
    info: text(raw.info),
    sales_rep: text(raw.sales_rep),
    transaction_id: text(raw.transaction_id),
  };
}

// The rows of the `Cashflow` sheet of a workbook buffer. The header row is found by its labels (it moved between workbook versions).
export async function readCashWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets.find((s) => norm(s.name) === "cashflow") ?? wb.worksheets.find((s) => norm(s.name) === "cash");
  if (!ws) throw new Error('The workbook has no "Cashflow" sheet');
  let headerRow = null;
  const cols = {};
  for (let r = 1; r <= Math.min(40, ws.rowCount) && !headerRow; r++) {
    const found = {};
    ws.getRow(r).eachCell((cell, c) => {
      const n = norm(cellValue(cell));
      for (const [field, aliases] of Object.entries(HEADER_ALIASES)) if (aliases.includes(n) && found[field] === undefined) found[field] = c;
    });
    if (found.date && found.amount && found.for) {
      headerRow = r;
      Object.assign(cols, found);
    }
  }
  if (!headerRow) throw new Error("Could not find the Cashflow table header (Date, Amount, For ...)");
  const rows = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw = {};
    let any = false;
    for (const [field, c] of Object.entries(cols)) {
      raw[field] = cellValue(row.getCell(c));
      if (raw[field] !== null && raw[field] !== "") any = true;
    }
    if (any) rows.push({ ...raw, excel_row: r });
  }
  return rows;
}

const guessKind = (name) => (/^cash\b/i.test(name) ? "cash" : /credit/i.test(name) ? "credit" : "bank");

// Replaces every Excel-origin ledger row with `rawRows` (raw = CASH_COLUMNS keys). Atomic. Returns { rows, skipped, accounts_added, categories_added }.
export async function applyCashLedger(rawRows, { via, userId = null, fileName = null, note = null } = {}) {
  const clean = [];
  let skipped = 0;
  for (const raw of rawRows) {
    const n = normalizeCashRow(raw);
    if (n.skip) skipped++;
    else clean.push({ ...n, excel_row: raw.excel_row ?? null });
  }
  if (!clean.length) throw new Error("No usable Cashflow rows");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const accounts = new Map((await client.query("SELECT id, name FROM cash_accounts")).rows.map((a) => [a.name.toLowerCase(), a.id]));
    const categories = new Map((await client.query("SELECT id, name FROM cash_categories")).rows.map((c) => [c.name.toLowerCase(), c.id]));
    let accountsAdded = 0;
    let categoriesAdded = 0;
    for (const name of new Set(clean.map((r) => r.account).filter(Boolean))) {
      if (accounts.has(name.toLowerCase())) continue;
      const { rows } = await client.query("INSERT INTO cash_accounts (name, kind) VALUES ($1, $2) RETURNING id", [name, guessKind(name)]);
      accounts.set(name.toLowerCase(), rows[0].id);
      accountsAdded++;
    }
    for (const name of new Set(clean.map((r) => r.category).filter(Boolean))) {
      if (categories.has(name.toLowerCase())) continue;
      // a category the sheet invented: an expense until the owner classifies it
      const { rows } = await client.query("INSERT INTO cash_categories (name, kind) VALUES ($1, 'expense') RETURNING id", [name]);
      categories.set(name.toLowerCase(), rows[0].id);
      categoriesAdded++;
    }
    await client.query("DELETE FROM cash_entries WHERE origin = 'excel'");
    const CHUNK = 1000;
    for (let i = 0; i < clean.length; i += CHUNK) {
      const part = clean.slice(i, i + CHUNK).map((r) => ({
        d: r.date, a: r.amount, c: r.currency, fx: r.fx_rate, aa: r.amount_amd,
        cat: r.category ? categories.get(r.category.toLowerCase()) : null,
        acc: r.account ? accounts.get(r.account.toLowerCase()) : null,
        cu: r.erp_customer_id, rf: r.ref, i: r.info, s: r.sales_rep, t: r.transaction_id, x: r.excel_row,
      }));
      await client.query(
        `INSERT INTO cash_entries (entry_date, amount, currency, fx_rate, amount_amd, category_id, account_id, erp_customer_id, ref, info, sales_rep, transaction_id, origin, excel_row)
         SELECT d, a, c, fx, aa, cat, acc, cu, rf, i, s, t, 'excel', x
         FROM jsonb_to_recordset($1::jsonb) AS x(d date, a numeric, c text, fx numeric, aa numeric, cat int, acc int, cu text, rf text, i text, s text, t text, x int)`,
        [JSON.stringify(part)]
      );
    }
    await client.query("INSERT INTO cash_syncs (via, rows_in, rows_skipped, file_name, user_id, note) VALUES ($1, $2, $3, $4, $5, $6)", [via, clean.length, skipped, fileName, userId, note]);
    await client.query("COMMIT");
    return { rows: clean.length, skipped, accounts_added: accountsAdded, categories_added: categoriesAdded };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
