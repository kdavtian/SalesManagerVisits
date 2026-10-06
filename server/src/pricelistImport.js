// Reads the company's pricelist workbook (the KF_Pricelist_*.xlsx layout: one
// sheet per brand with a product photo anchored on each model's first row,
// plus a "Commercial oils" sheet with technical text) and matches what it
// finds to the products already in the app: photos become the product's main
// front image, commercial rows fill description / specifications /
// approvals and flag the product as commercial. Prices are NOT touched --
// the Castrol workbook sync owns those.
import ExcelJS from "exceljs";
import { parseLiters } from "../../client/public/js/productSort.js";

const BRAND_WORDS = new Set(["castrol", "lotos", "orlen", "royal"]);
const STOP_WORDS = new Set(["engine", "oil", "fully", "synthetic"]);

// "Edge 0W-20 C5 4L" -> ["edge","0w20","c5"]: lower-case, hyphens dropped
// inside a grade, brand words / pack sizes / filler words removed.
export function nameTokens(name) {
  const cleaned = String(name || "")
    .toLowerCase()
    .replace(/(\d)\s*[-–]\s*(\d)/g, "$1$2")
    .replace(/(\d+w)\s*[-–]\s*(\d+)/g, "$1$2")
    .replace(/[^a-z0-9.ա-ֆ]+/giu, " ");
  return cleaned
    .split(" ")
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t && !BRAND_WORDS.has(t) && !STOP_WORDS.has(t) && !/^\d+(\.\d+)?l$/.test(t));
}

function cellText(cell) {
  const v = cell?.value;
  if (v == null) return "";
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    return "";
  }
  return String(v);
}

function isMergedSlave(cell) {
  return Boolean(cell.isMerged && cell.master && cell.master.address !== cell.address);
}

function sizeLiters(text) {
  const m = String(text || "").replace(",", ".").match(/([\d.]+)\s*[լլ]/u);
  return m ? Number(m[1]) : null;
}

// Splits the commercial sheet's technical text into description / specs /
// approvals (see the sheet: line 1 description, "SAE ..." line, "Հավանություններ՝"
// line, "Տիպային՝" typical-properties line).
export function parseTechText(text) {
  const out = { description: null, specs: [], approvals: [] };
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  lines.forEach((line, idx) => {
    if (line.startsWith("Հավանություններ՝")) {
      out.approvals = line
        .replace("Հավանություններ՝", "")
        .split("·")
        .map((a) => a.trim())
        .filter(Boolean);
    } else if (line.startsWith("Տիպային՝")) {
      for (const part of line.replace("Տիպային՝", "").split("·").map((p) => p.trim()).filter(Boolean)) {
        const colon = part.indexOf("՝");
        if (colon > 0) out.specs.push({ label: part.slice(0, colon).trim(), value: part.slice(colon + 1).trim() });
        else if (/գ\/մլ$/u.test(part)) out.specs.push({ label: "Խտություն", value: part });
        else {
          const sp = part.indexOf(" ");
          out.specs.push(sp > 0 ? { label: part.slice(0, sp), value: part.slice(sp + 1) } : { label: part, value: "" });
        }
      }
    } else if (idx === 0) {
      out.description = line;
    } else {
      for (const part of line.split("·").map((p) => p.trim()).filter(Boolean)) {
        const sp = part.indexOf(" ");
        out.specs.push(sp > 0 ? { label: part.slice(0, sp), value: part.slice(sp + 1) } : { label: part, value: "" });
      }
    }
  });
  return out;
}

const PASSENGER_SHEETS = [
  { match: /^castrol$/i, brand: "Castrol" },
  { match: /^royal$/i, brand: "Royal" },
  { match: /lotos/i, brand: null }, // brand headings inside the sheet
];

function imagesBySheet(workbook, ws) {
  return ws.getImages().map((img) => {
    const media = workbook.getImage(Number(img.imageId));
    return { row: img.range.tl.nativeRow + 1, col: img.range.tl.nativeCol, buffer: media?.buffer ?? null, ext: media?.extension ?? "png" };
  });
}

/** Parse the workbook into model groups: { sheet, brand, name, rowStart, rowEnd, sizes[], image, commercial }. */
export async function parsePricelistWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const groups = [];

  for (const ws of workbook.worksheets) {
    const passenger = PASSENGER_SHEETS.find((s) => s.match.test(ws.name));
    const images = imagesBySheet(workbook, ws).filter((i) => i.row > 7 && i.buffer);

    if (passenger) {
      let brand = passenger.brand;
      let current = null;
      for (let r = 8; r <= ws.rowCount; r++) {
        const bText = cellText(ws.getCell(r, 2)).trim();
        const nameCell = ws.getCell(r, 3);
        const sizeText = cellText(ws.getCell(r, 4)).trim();
        if (bText && !sizeText && !cellText(nameCell).trim()) {
          brand = bText.charAt(0).toUpperCase() + bText.slice(1).toLowerCase();
          current = null;
          continue;
        }
        const name = cellText(nameCell).trim();
        if (name && !isMergedSlave(nameCell)) {
          current = { sheet: ws.name, brand, name, rowStart: r, rowEnd: r, sizes: [], image: null, commercial: false };
          groups.push(current);
        }
        if (current && sizeText) {
          current.rowEnd = r;
          const liters = sizeLiters(sizeText);
          if (liters != null) current.sizes.push(liters);
        }
      }
      for (const img of images) {
        const g = groups.find((x) => x.sheet === ws.name && img.row >= x.rowStart && img.row <= x.rowEnd);
        if (g && !g.image) g.image = img;
      }
    } else if (/կոմերցիոն/i.test(ws.name)) {
      let brand = null;
      let current = null;
      for (let r = 8; r <= ws.rowCount; r++) {
        const nameCell = ws.getCell(r, 2);
        const name = cellText(nameCell).trim();
        const sizeText = cellText(ws.getCell(r, 4)).trim();
        if (name && !sizeText) {
          brand = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
          current = null;
          continue;
        }
        if (name && !isMergedSlave(nameCell)) {
          current = { sheet: ws.name, brand, name, rowStart: r, rowEnd: r, sizes: [], image: null, commercial: true, tech: cellText(ws.getCell(r, 3)).trim() };
          groups.push(current);
        }
        if (current && sizeText) {
          current.rowEnd = r;
          const liters = sizeLiters(sizeText);
          if (liters != null) current.sizes.push(liters);
        }
      }
      for (const img of images) {
        const g = groups.find((x) => x.sheet === ws.name && img.row >= x.rowStart && img.row <= x.rowEnd);
        if (g && !g.image) g.image = img;
      }
    }
  }
  return groups;
}

/**
 * Match parsed groups to products. Each product gets its single best group:
 * every group token must appear in the product's tokens (and the brand must
 * agree); more matched tokens wins, then fewer extra product tokens. For the
 * commercial sheet the pack size must also be one of the group's sizes.
 */
export function matchGroupsToProducts(groups, products) {
  const prepared = groups.map((g) => ({ g, tokens: nameTokens(g.name) })).filter((x) => x.tokens.length);
  const matches = new Map(); // group -> products[]
  const unmatchedProducts = [];
  for (const p of products) {
    const pTokens = new Set(nameTokens(p.name));
    const liters = parseLiters(p.unit);
    let best = null;
    for (const cand of prepared) {
      if (cand.g.brand && p.brand && cand.g.brand.toLowerCase() !== String(p.brand).toLowerCase()) continue;
      if (!cand.tokens.every((t) => pTokens.has(t))) continue;
      const sizeOk = !cand.g.sizes.length || liters == null || cand.g.sizes.includes(liters);
      // A commercial row is one specific pack size; a passenger model's photo
      // is shared by every size, the size only breaks ties.
      if (cand.g.commercial && !sizeOk) continue;
      const extras = pTokens.size - cand.tokens.length;
      const better =
        !best ||
        cand.tokens.length > best.n ||
        (cand.tokens.length === best.n && sizeOk && !best.sizeOk) ||
        (cand.tokens.length === best.n && sizeOk === best.sizeOk && extras < best.extras);
      if (better) best = { cand, n: cand.tokens.length, extras, sizeOk };
    }
    if (best) {
      if (!matches.has(best.cand.g)) matches.set(best.cand.g, []);
      matches.get(best.cand.g).push(p);
    } else unmatchedProducts.push(p);
  }
  return { matches, unmatchedProducts };
}
