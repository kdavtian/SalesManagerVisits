// A small, tolerant .xlsx reader for bank statements (owner, 2026-11-11: the Evoca statement could not be opened at all).
// ExcelJS is the first reader of statement files (bankStatement.js), but some banks write their workbooks with a .NET library that prefixes every
// tag (<x:workbook>, <x:row> ...), puts 20 decorative tables into the sheet and uses absolute part paths: ExcelJS throws on those ("Cannot read
// properties of undefined"). This reader only needs the first sheet's cell values, so it ignores everything else (tables, themes, properties) and
// matches tags by their LOCAL name, whatever the prefix. Output: rows of cell values, empty rows left out -- the same shape the statement code expects.
import JSZip from "jszip";
import { SaxesParser } from "saxes";

const MAX_XML_BYTES = 60 * 1024 * 1024; // a statement is a few hundred KB: refuse a zip bomb
const MAX_PARTS = 2000;
const MAX_COLUMN = 16383; // XFD, Excel's last column
const MAX_ROW = 1048576; // Excel's last row

async function partText(zip, name) {
  const entry = zip.file(name) ?? zip.file(name.replace(/^\//, ""));
  if (!entry) return null;
  // the size the zip DECLARES is checked before anything is inflated (a 15 MB upload can hide gigabytes)
  const declared = entry._data?.uncompressedSize;
  if (Number(declared) > MAX_XML_BYTES) throw new Error("The workbook part is too large");
  const text = await entry.async("string");
  if (text.length > MAX_XML_BYTES) throw new Error("The workbook part is too large");
  return text.replace(/^﻿/, "");
}

// Walks an XML text; `on` gets (event, node|text). Local names only.
function walk(xml, handlers) {
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", (err) => {
    throw err;
  });
  parser.on("opentag", (node) => handlers.open?.(node.local, node));
  parser.on("text", (text) => handlers.text?.(text));
  parser.on("cdata", (text) => handlers.text?.(text));
  parser.on("closetag", (node) => handlers.close?.(node.local, node));
  parser.write(xml).close();
}

const attr = (node, name) => node.attributes[name]?.value;

function sheetPath(workbookXml, relsXml) {
  let rid = null;
  walk(workbookXml, {
    open(local, node) {
      if (local === "sheet" && rid === null) rid = node.attributes["r:id"]?.value ?? Object.values(node.attributes).find((a) => a.local === "id")?.value ?? null;
    },
  });
  if (!rid || !relsXml) return null;
  let target = null;
  walk(relsXml, {
    open(local, node) {
      if (local === "Relationship" && attr(node, "Id") === rid) target = attr(node, "Target");
    },
  });
  if (!target) return null;
  return target.startsWith("/") ? target.slice(1) : `xl/${target}`.replace(/xl\/\.\.\//, "");
}

async function sharedStrings(zip) {
  const xml = await partText(zip, "xl/sharedStrings.xml");
  const out = [];
  if (!xml) return out;
  let inSi = false;
  let inPhonetic = false;
  let inT = false;
  let current = "";
  walk(xml, {
    open(local) {
      if (local === "si") {
        inSi = true;
        current = "";
      } else if (local === "rPh") inPhonetic = true;
      else if (local === "t" && inSi && !inPhonetic) inT = true;
    },
    text(text) {
      if (inT) current += text;
    },
    close(local) {
      if (local === "t") inT = false;
      else if (local === "rPh") inPhonetic = false;
      else if (local === "si") {
        out.push(current);
        inSi = false;
      }
    },
  });
  return out;
}

// Which style indexes hold dates: the built-in date formats and custom formats with day / month / year tokens.
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
const isDateCode = (code) => /[dmy]/i.test(String(code).replace(/"[^"]*"|\[[^\]]*\]|\\./g, "")) && !/^general$/i.test(code);

async function dateStyles(zip) {
  const xml = await partText(zip, "xl/styles.xml");
  const dates = new Set();
  if (!xml) return dates;
  const custom = new Map();
  const xfs = [];
  let inCellXfs = false;
  walk(xml, {
    open(local, node) {
      if (local === "numFmt") custom.set(Number(attr(node, "numFmtId")), attr(node, "formatCode") ?? "");
      else if (local === "cellXfs") inCellXfs = true;
      else if (local === "xf" && inCellXfs) xfs.push(Number(attr(node, "numFmtId") ?? 0));
    },
    close(local) {
      if (local === "cellXfs") inCellXfs = false;
    },
  });
  xfs.forEach((id, index) => {
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateCode(custom.get(id)))) dates.add(index);
  });
  return dates;
}

const colIndex = (ref) => {
  const letters = /^[A-Z]{1,3}/i.exec(ref ?? "")?.[0] ?? "";
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1 > MAX_COLUMN ? -1 : n - 1; // a crafted reference ("ZZZZZZZZ1") would make an array of billions
};

// Excel serial day number -> a Date at UTC midnight (the 1900 system, with its leap-year bug for dates after 28 Feb 1900).
const serialToDate = (n) => new Date(Math.round((n - 25569) * 86400000));

export async function readXlsxRows(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  if (Object.keys(zip.files).length > MAX_PARTS) throw new Error("The workbook has too many parts");
  const workbookXml = await partText(zip, "xl/workbook.xml");
  const relsXml = await partText(zip, "xl/_rels/workbook.xml.rels");
  const path = (workbookXml && sheetPath(workbookXml, relsXml)) || "xl/worksheets/sheet1.xml";
  const sheetXml = await partText(zip, path);
  if (!sheetXml) throw new Error("The workbook has no readable sheet");
  const [strings, dateStyleSet] = await Promise.all([sharedStrings(zip), dateStyles(zip)]);
  const rows = new Map(); // row number -> array of values
  let cell = null;
  let inV = false;
  let inInlineT = false;
  walk(sheetXml, {
    open(local, node) {
      if (local === "c") {
        const ref = attr(node, "r");
        const rowNumber = Number(/\d+/.exec(ref ?? "")?.[0] ?? 0);
        cell = { row: rowNumber, col: colIndex(ref), t: attr(node, "t") ?? "n", s: Number(attr(node, "s") ?? -1), v: "", inline: "" };
      } else if (local === "v" && cell) inV = true;
      else if (local === "t" && cell && cell.t === "inlineStr") inInlineT = true;
    },
    text(text) {
      if (inV && cell) cell.v += text;
      else if (inInlineT && cell) cell.inline += text;
    },
    close(local) {
      if (local === "v") inV = false;
      else if (local === "t") inInlineT = false;
      else if (local === "c" && cell) {
        let value = "";
        if (cell.t === "s") value = strings[Number(cell.v)] ?? "";
        else if (cell.t === "inlineStr") value = cell.inline;
        else if (cell.t === "str" || cell.t === "e") value = cell.v;
        else if (cell.t === "b") value = cell.v === "1";
        else if (cell.v !== "") {
          const n = Number(cell.v);
          value = Number.isFinite(n) ? (dateStyleSet.has(cell.s) ? serialToDate(n) : n) : cell.v;
        }
        if (cell.row > 0 && cell.row <= MAX_ROW && cell.col >= 0 && value !== "") {
          const row = rows.get(cell.row) ?? [];
          row[cell.col] = value;
          rows.set(cell.row, row);
        }
        cell = null;
      }
    },
  });
  // fill the holes (a sparse array has undefined gaps) and keep the sheet order
  return [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => Array.from({ length: row.length }, (_, i) => row[i] ?? ""));
}
