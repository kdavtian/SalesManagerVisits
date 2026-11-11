// Bank statements (owner, 2026-10-24, Cashflow phase 3): a CSV / Excel statement of one bank account is read into lines, kept (so it is never
// imported twice) and reconciled against the Cashflow ledger. Excel stays the main ledger for now, so a bank line and its Excel row are the SAME money:
// a line that finds its row is "matched" (never added again), a line without a row is listed for the accountant to add or ignore.
// Matching is computed from the current ledger every time (the Excel refresh replaces its rows, so ids cannot be remembered).
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { ymd } from "./cashflow.js";
import { readXlsxRows } from "./xlsxLite.js";

const norm = (v) => String(v ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Header words of the banks we expect (English, Armenian, Russian). First match wins per field.
const ALIASES = {
  date: ["date", "booking date", "transaction date", "value date", "posting date", "operation date", "ամսաթիվ", "գործարքի ամսաթիվ", "дата", "дата операции", "дата проводки"],
  amount: ["amount", "sum", "transaction amount", "գումար", "сумма", "сумма операции"],
  debit: ["debit", "ելք", "debit amount", "debits", "withdrawal", "withdrawals", "paid out", "money out", "expense", "դեբետ", "дебет", "расход"],
  credit: ["credit", "մուտք", "credit amount", "credits", "deposit", "deposits", "paid in", "money in", "income", "կրեդիտ", "кредит", "приход"],
  description: ["description", "details", "narrative", "purpose", "payment details", "payment purpose", "memo", "remarks", "comment", "info", "նկարագրություն", "նպատակ", "վճարման նպատակ", "назначение платежа", "назначение", "комментарий", "описание"],
  counterparty: ["counterparty", "վճարող շահառու", "beneficiary", "payer", "receiver", "recipient", "sender", "partner", "name", "վճարող", "ստացող", "գործընկեր", "получатель", "плательщик", "отправитель", "контрагент"],
  reference: ["reference", "փաստ n", "փաստ", "ref", "document no", "document number", "doc no", "transaction id", "id", "փաստաթուղթ", "փաստաթղթի համար", "номер документа", "документ", "референс"],
  currency: ["currency", "ccy", "արժույթ", "валюта"],
  balance: ["balance", "running balance", "մնացորդ", "остаток"],
  // Evoca (2026-11): "ԳՏ" = the kind of operation (TRF transfer, FEE commission, MSC other) and "Հաշիվ" = the other side's account number
  type_code: ["type", "transaction type", "operation type", "գտ", "գործարքի տեսակ", "тип", "вид операции"],
  counterparty_account: ["account", "account number", "counterparty account", "iban", "հաշիվ", "հաշվեհամար", "счет", "счёт"],
};
export const FIELDS = Object.keys(ALIASES);

// ---- reading the file --------------------------------------------------------------------------------------------------------------------

function decodeText(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  if (!utf8.includes("�")) return utf8.replace(/^﻿/, "");
  return new TextDecoder("windows-1251").decode(buffer); // a legacy Cyrillic export
}

export function parseCsv(textContent) {
  const lines = textContent.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  const sample = lines.slice(0, 15).join("\n");
  const delim = [";", "\t", ",", "|"].map((d) => [d, sample.split(d).length - 1]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  // A small state machine: quoted cells may hold the delimiter, doubled quotes and (rarely) line breaks, so the whole text is walked once.
  const textAll = textContent.replace(/\r\n|\r/g, "\n");
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < textAll.length; i++) {
    const ch = textAll[i];
    if (quoted) {
      if (ch === '"' && textAll[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); cell = ""; if (row.some((c) => c.trim() !== "")) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

function cellToPlain(cell) {
  let v = cell?.value;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) v = v.result;
    else if ("richText" in v) v = v.richText.map((r) => r.text).join("");
    else if ("text" in v) v = v.text;
  }
  if (v && typeof v === "object" && !(v instanceof Date)) return "";
  return v ?? "";
}

async function readRows(buffer, fileName) {
  const isXlsx = /\.xlsx$/i.test(fileName ?? "") || (buffer[0] === 0x50 && buffer[1] === 0x4b); // "PK" = a zip = a workbook
  if (!isXlsx) return parseCsv(decodeText(buffer));
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error("The workbook has no sheet");
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const out = [];
      const width = Math.max(r.cellCount, r.actualCellCount);
      for (let c = 1; c <= width; c++) out.push(cellToPlain(r.getCell(c)));
      rows.push(out);
    });
    return rows;
  } catch (err) {
    // Some banks (Evoca) write workbooks ExcelJS cannot open (prefixed XML tags, decorative tables): the small tolerant reader takes over.
    try {
      const rows = await readXlsxRows(buffer);
      if (rows.length) return rows;
    } catch {
      // fall through to the first error
    }
    throw err;
  }
}

// ---- reading the values ------------------------------------------------------------------------------------------------------------------

export function parseAmount(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[\s  ]/g, "");
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-$/.test(s)) { negative = true; s = s.slice(0, -1); }
  if (/^[-−–]/.test(s)) { negative = !negative; s = s.slice(1); }
  s = s.replace(/^\+/, "").replace(/[A-Za-z]{3}$|^[A-Za-z]{3}/, "").replace(/[֏$€₽]/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (lastComma >= 0) s = /,\d{1,2}$/.test(s) && s.split(",").length === 2 ? s.replace(",", ".") : s.replace(/,/g, "");
  if (!/^\d*\.?\d+$/.test(s) && !/^\d+\.?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

function parseDate(v) {
  if (v instanceof Date) return ymd(v);
  const s = String(v ?? "").trim();
  if (!s) return null;
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (dmy) {
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${year}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  return null;
}

// Which column holds which field: by the header words. `mapping` (field -> column index) overrides it when the accountant corrected it.
export function detectLayout(rows, mapping = null) {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const found = {};
    rows[r].forEach((cell, c) => {
      const n = norm(cell);
      if (!n) return;
      for (const field of FIELDS) if (ALIASES[field].includes(n) && found[field] === undefined) found[field] = c;
    });
    if (found.date !== undefined && (found.amount !== undefined || found.debit !== undefined || found.credit !== undefined)) {
      return { headerRow: r, headers: rows[r].map((h) => String(h ?? "")), mapping: mapping ?? found, detected: found };
    }
  }
  // No usable header: the first row still names the columns for the manual mapping.
  return { headerRow: rows.length ? 0 : -1, headers: (rows[0] ?? []).map((h) => String(h ?? "")), mapping: mapping ?? {}, detected: {} };
}

// ---- the header block and the daily subtotal rows some banks print (Evoca) ----------------------------------------------------------------
// Above the table: period, account number and holder, currency, TIN, opening balance, total movement, closing balance. Inside it, after every day:
// a "Movement dd/mm/yyyy" row (that day's money in / out) and a "Balance dd/mm/yyyy" row. None of these is a transaction; together they are the
// statement's own proof of what it contains, so the lines read are checked against them (checkStatement) before anything is imported.
const META_LABELS = [
  ["period_from", /^(ժամանակահատվածի սկիզբ|period start|from|start date|период с|начало)$/],
  ["period_to", /^(ժամանակահատվածի վերջ|period end|to|end date|период по|конец)$/],
  ["account_number", /^(հաշիվ n|հաշիվ|հաշվեհամար|account|account no|account number|iban|счет|счёт|номер счета)$/],
  ["currency", /^(արժույթ|currency|ccy|валюта)$/],
  ["tin", /^(հվհհ|tin|vat number|инн|унп)$/],
  ["opening_balance", /^(սկզբնական մնացորդ|opening balance|начальный остаток|входящий остаток)/],
  ["total_out", /^(ընդհանուր շարժ դեբետով|total debit|total debits|debit turnover|оборот по дебету)/],
  ["total_in", /^(ընդհանուր շարժ կրեդիտով|total credit|total credits|credit turnover|оборот по кредиту)/],
  ["closing_balance", /^(վերջնական մնացորդ|closing balance|исходящий остаток|конечный остаток)/],
];

function readMeta(rows, headerRow) {
  const meta = {};
  for (let r = 0; r < Math.max(0, headerRow); r++) {
    const row = rows[r] ?? [];
    const label = norm(row[0]);
    if (!label) continue;
    for (const [key, re] of META_LABELS) {
      if (meta[key] !== undefined || !re.test(label)) continue;
      const value = row[1];
      if (key === "period_from" || key === "period_to") meta[key] = parseDate(value);
      else if (key === "opening_balance" || key === "closing_balance" || key === "total_in" || key === "total_out") meta[key] = parseAmount(value);
      else if (key === "account_number") {
        meta.account_number = String(value ?? "").replace(/\s+/g, "").toUpperCase() || undefined;
        const holder = String(row[2] ?? "").trim();
        if (holder) meta.holder = holder;
      } else if (key === "currency") {
        const c = String(value ?? "").trim().toUpperCase();
        if (c) meta.currency = c === "$" ? "USD" : c;
      } else meta[key] = String(value ?? "").trim() || undefined;
      break;
    }
  }
  return meta;
}

// (JavaScript's \b only knows ASCII letters, so the word ends are written as "space or end")
const DAY_ROW_MOVEMENT = /^(շարժ|movement|turnover|оборот)(?=\s|$)/;
const DAY_ROW_BALANCE = /^(մնացորդ|balance|остаток)(?=\s|$)/;
const SKIP_ROW_WORDS = /^(օրերի քանակ|number of days|total|totals|ընդամենը|итого|շարժ|մնացորդ|movement|balance|оборот|остаток)(?=\s|$)/;

const dateInText = (text) => {
  const m = /(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})/.exec(String(text ?? ""));
  return m ? parseDate(m[1]) : null;
};

// Does the statement prove itself? Compares what was read with the statement's own totals; returns { ok: true | false | null (nothing to compare), items }.
export function checkStatement(lines, meta, days) {
  const items = [];
  const round = (n) => Math.round(n * 100) / 100;
  const sumIn = round(lines.filter((l) => l.amount > 0).reduce((a, l) => a + l.amount, 0));
  const sumOut = round(lines.filter((l) => l.amount < 0).reduce((a, l) => a - l.amount, 0));
  let compared = 0;
  const cmp = (kind, expected, got, extra = {}) => {
    if (expected === null || expected === undefined) return;
    compared++;
    if (Math.abs(expected - got) > 0.01) items.push({ kind, expected, got: round(got), ...extra });
  };
  cmp("total_in", meta.total_in, sumIn);
  cmp("total_out", meta.total_out, sumOut);
  if (meta.opening_balance != null && meta.closing_balance != null) cmp("closing_balance", meta.closing_balance, meta.opening_balance + sumIn - sumOut);
  // each day: the movement row, and the running balance after it
  const byDay = new Map();
  for (const l of lines) {
    const d = byDay.get(l.line_date) ?? { in: 0, out: 0 };
    if (l.amount > 0) d.in += l.amount;
    else d.out -= l.amount;
    byDay.set(l.line_date, d);
  }
  let running = meta.opening_balance ?? null;
  const dates = [...new Set([...byDay.keys(), ...days.keys()])].sort();
  for (const date of dates) {
    const got = byDay.get(date) ?? { in: 0, out: 0 };
    const day = days.get(date);
    if (day?.in != null) cmp("day_in", day.in, got.in, { date });
    if (day?.out != null) cmp("day_out", day.out, got.out, { date });
    if (running !== null) running = round(running + got.in - got.out);
    if (day?.balance != null && running !== null) cmp("day_balance", day.balance, running, { date });
    if (day?.balance != null) running = day.balance; // one wrong day must not flag every day after it
  }
  return { ok: compared ? items.length === 0 : null, compared, items: items.slice(0, 30), problems: items.length };
}

// The statement as clean lines: { line_date, amount (signed: + in, - out), currency, description, counterparty, reference, balance, type_code, counterparty_account }
// plus the rows that could not be read, the header block (meta) and the check against the statement's own totals.
export async function readStatement(buffer, fileName, { mapping = null, defaultCurrency = "AMD" } = {}) {
  const rows = await readRows(buffer, fileName);
  if (!rows.length) throw new Error("The file is empty");
  const layout = detectLayout(rows, mapping);
  const m = layout.mapping;
  const hasAmount = m.amount !== undefined || m.debit !== undefined || m.credit !== undefined;
  if (m.date === undefined || !hasAmount) return { ...layout, lines: [], skipped: [], needsMapping: true, meta: {}, checks: { ok: null, compared: 0, items: [], problems: 0 }, days: new Map() };
  const meta = layout.headerRow > 0 ? readMeta(rows, layout.headerRow) : {};
  const statementCurrency = meta.currency ?? defaultCurrency;
  const headerKey = layout.headers.map((h) => norm(h)).join("|");
  const lines = [];
  const skipped = [];
  const days = new Map(); // date -> { in, out, balance }: the bank's own daily subtotal rows
  const cellAt = (row, field) => (m[field] === undefined ? "" : row[m[field]] ?? "");
  for (let r = layout.headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => String(c ?? "").trim() === "")) continue;
    // the header printed again above every day: not a line, not an error
    if (row.map((h) => norm(h)).join("|") === headerKey) continue;
    const date = parseDate(cellAt(row, "date"));
    if (!date) {
      // subtotal / footer rows ("Movement 01/10/2026", "Balance 01/10/2026", "Number of days"): kept as proof, never as a line
      const at = row.findIndex((c) => SKIP_ROW_WORDS.test(norm(c)));
      if (at >= 0) {
        const lead = norm(row[at]);
        const dayDate = dateInText(row[at]);
        if (dayDate && DAY_ROW_MOVEMENT.test(lead)) {
          const d = days.get(dayDate) ?? {};
          d.in = parseAmount(cellAt(row, "credit")) ?? parseAmount(cellAt(row, "amount")) ?? d.in;
          d.out = parseAmount(cellAt(row, "debit")) ?? d.out;
          days.set(dayDate, d);
        } else if (dayDate && DAY_ROW_BALANCE.test(lead)) {
          const d = days.get(dayDate) ?? {};
          // the balance sits in the first amount cell of the row (Evoca prints it under "Out")
          d.balance = row.map((c) => parseAmount(c)).find((n) => n !== null && n !== undefined) ?? d.balance;
          days.set(dayDate, d);
        }
        continue;
      }
    }
    let amount = null;
    if (m.amount !== undefined) amount = parseAmount(cellAt(row, "amount"));
    if (amount === null || amount === 0) {
      const debit = parseAmount(cellAt(row, "debit"));
      const credit = parseAmount(cellAt(row, "credit"));
      if (credit) amount = Math.abs(credit);
      else if (debit) amount = -Math.abs(debit);
    } else if (m.debit !== undefined && m.credit === undefined && m.amount === undefined) amount = -Math.abs(amount);
    if (!date || amount === null || amount === 0) {
      skipped.push({ row: r + 1, reason: !date ? "no date" : "no amount" });
      continue;
    }
    const ccy = String(cellAt(row, "currency") || statementCurrency).trim().toUpperCase();
    const currency = ccy === "USD" || ccy === "$" ? "USD" : ccy === "AMD" || ccy === "" || ccy === "֏" || ccy === "DRAM" ? "AMD" : null;
    if (!currency) {
      skipped.push({ row: r + 1, reason: `currency ${ccy}` });
      continue;
    }
    const text = (f, max) => String(cellAt(row, f) ?? "").trim().slice(0, max) || null;
    lines.push({
      line_date: date,
      amount: Math.round(amount * 100) / 100,
      currency,
      description: text("description", 500),
      counterparty: text("counterparty", 200),
      reference: text("reference", 100),
      balance: m.balance === undefined ? null : parseAmount(cellAt(row, "balance")),
      type_code: text("type_code", 20),
      counterparty_account: text("counterparty_account", 60),
    });
  }
  return { ...layout, lines, skipped, needsMapping: false, meta, days, checks: checkStatement(lines, meta, days) };
}

// A stable identity of a line: the same statement (or an overlapping one) read again gives the same hashes, so nothing is imported twice. Identical
// lines inside one file (two equal payments the same day) are told apart by their order of appearance.
export function hashLines(accountId, lines) {
  const seen = new Map();
  return lines.map((l) => {
    const key = [accountId, l.line_date, l.amount, l.currency, l.reference ?? "", l.description ?? "", l.counterparty ?? "", l.balance ?? ""].join("|");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return crypto.createHash("sha1").update(`${key}#${n}`).digest("hex");
  });
}

// ---- reconciling -------------------------------------------------------------------------------------------------------------------------

const dayNumber = (d) => Math.round(new Date(`${String(d).slice(0, 10)}T00:00:00Z`).getTime() / 86400000);

// lines / entries: { id, date, amount, currency } (same account). Returns Map(line id -> entry id) for the lines that found their row: the same signed
// amount in the same currency within `days` days, nearest date first, every row used at most once.
export function matchLines(lines, entries, { days = 3 } = {}) {
  const result = new Map();
  const taken = new Set();
  const sorted = [...lines].sort((a, b) => dayNumber(a.date) - dayNumber(b.date) || a.id - b.id);
  for (const line of sorted) {
    let best = null;
    for (const e of entries) {
      if (taken.has(e.id) || e.currency !== line.currency || Math.abs(e.amount - line.amount) > 0.005) continue;
      const gap = Math.abs(dayNumber(e.date) - dayNumber(line.date));
      if (gap > days) continue;
      if (!best || gap < best.gap || (gap === best.gap && e.id < best.id)) best = { id: e.id, gap };
    }
    if (best) {
      taken.add(best.id);
      result.set(line.id, best.id);
    }
  }
  return result;
}
