// Pricelist PDF (Armenian), modelled on the company's Excel pricelist: one
// section per brand with a product photo, name, volume and tier price
// columns, plus a landscape "Commercial oils" section with technical data and
// per-litre prices. Generated per user: a sales manager's contact block shows
// their own name/phone/email plus the office line, management's shows the
// office details only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { compareProducts, parseLiters, BRAND_PRIORITY } from "../../client/public/js/productSort.js";

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "fonts");

export const OFFICE_PHONE = "091-007-019";

const TIER_COLUMNS = {
  bronze: { label: "BRONZE\nԴրամ", title: "Bronze", get: (p) => num(p.bronze_price_amd) ?? num(p.unit_price_amd) },
  silver: { label: "SILVER\nԴրամ", title: "Silver", get: (p) => num(p.silver_price_amd) },
  gold: { label: "GOLD\nԴրամ", title: "Gold", get: (p) => num(p.gold_price_amd) },
  retail: { label: "Մանրածախ\nԴրամ", title: null, get: (p) => num(p.effective_retail_amd ?? p.retail_price_amd) },
};
export const PDF_COLUMN_ORDER = ["bronze", "silver", "gold", "retail"];

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function formatPrice(n) {
  return n == null ? "—" : Math.round(n).toLocaleString("en-US");
}

// "4L" / "0.5 L" -> "4 լ" (Armenian, as in the Excel); other units as-is.
export function formatVolume(unit) {
  const liters = parseLiters(unit);
  if (liters == null) return unit || "";
  return `${Number.isInteger(liters) ? liters : String(liters)} լ`;
}

// Model name without the trailing pack size: "Castrol EDGE 5W-40 4L" ->
// "Castrol EDGE 5W-40", so every size of one model groups into one block.
export function modelName(product) {
  return String(product.name || "")
    .replace(/\s*[-–·]?\s*\d+(?:[.,]\d+)?\s*[LlԼլ]\s*$/u, "")
    .trim();
}

// Brand sections in priority order (Castrol, Lotos, Orlen, Royal, then the rest).
export function brandOrder(brands) {
  const known = BRAND_PRIORITY.filter((b) => brands.includes(b));
  const rest = brands.filter((b) => !BRAND_PRIORITY.includes(b)).sort((a, b) => a.localeCompare(b));
  return [...known, ...rest];
}

// One group per model; its sizes ascending.
export function groupByModel(products) {
  const sorted = [...products].sort(compareProducts);
  const groups = new Map();
  for (const p of sorted) {
    const key = `${p.brand || ""}|${modelName(p).toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { name: modelName(p), brand: p.brand || "", items: [] });
    groups.get(key).items.push(p);
  }
  for (const g of groups.values()) {
    g.items.sort((a, b) => (parseLiters(a.unit) ?? 1e9) - (parseLiters(b.unit) ?? 1e9));
  }
  return [...groups.values()];
}

export function formatValidUntil(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate || ""));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
}

function loadImage(cache, uploadDir, imagePath) {
  if (!imagePath) return null;
  if (cache.has(imagePath)) return cache.get(imagePath);
  let buf = null;
  // pdfkit embeds JPEG and PNG only; a WebP photo simply gets no thumbnail.
  if (/\.(jpe?g|png)$/i.test(imagePath)) {
    try {
      buf = fs.readFileSync(path.join(uploadDir, imagePath));
    } catch {
      buf = null;
    }
  }
  cache.set(imagePath, buf);
  return buf;
}

/**
 * @param {object} opts
 * @param {object[]} opts.products   priced + redacted product rows (see routes/products.js)
 * @param {string[]} opts.columns    subset of PDF_COLUMN_ORDER (already role-checked)
 * @param {string}   opts.validUntil YYYY-MM-DD
 * @param {boolean}  opts.includePhotos
 * @param {boolean}  opts.includeCommercial
 * @param {object}   opts.contact    { mode: "rep"|"office", name, phone, email, officePhone }
 * @param {string}   opts.uploadDir
 * @returns PDFKit document (call .end() after piping)
 */
export function buildPricelistPdf({ products, columns, validUntil, includePhotos, includeCommercial, contact, uploadDir }) {
  const cols = PDF_COLUMN_ORDER.filter((c) => columns.includes(c));
  const tierTitles = cols.map((c) => TIER_COLUMNS[c].title).filter(Boolean);
  const title = `Մեծածախ գնացուցակ${tierTitles.length ? `  ·  ${tierTitles.join("  ·  ")}` : ""}`;
  const imageCache = new Map();

  const regular = products.filter((p) => !p.is_commercial);
  const commercial = includeCommercial && cols.some((c) => c !== "retail") ? products.filter((p) => p.is_commercial) : [];
  const commercialOnly = !regular.length && commercial.length > 0;

  const doc = new PDFDocument({ size: "A4", layout: commercialOnly ? "landscape" : "portrait", margin: 32, bufferPages: true, info: { Title: title, Author: "KAD Motors" } });
  doc.registerFont("R", path.join(FONT_DIR, "DejaVuSans.ttf"));
  doc.registerFont("B", path.join(FONT_DIR, "DejaVuSans-Bold.ttf"));

  const INK = "#111318";
  const DIM = "#5b6270";
  const LINE = "#d9dce1";
  const BAND = "#1f2937";
  const ZEBRA = "#f6f7f9";
  const margin = 32;

  const contentWidth = () => doc.page.width - margin * 2;
  const bottomLimit = () => doc.page.height - margin - 14;

  function drawContactBox(x, y, w) {
    const lines = [];
    if (contact.mode === "rep" && contact.name) lines.push(`Վաճառքի մենեջեր՝ ${contact.name}`);
    if (contact.email) lines.push(`Էլ. հասցե՝ ${contact.email}`);
    const phones = [];
    if (contact.mode === "rep" && contact.phone) phones.push(`Հեռ.՝ ${contact.phone}`);
    phones.push(`Գրասենյակ՝ ${contact.officePhone || OFFICE_PHONE}`);
    lines.push(phones.join(" | "));
    doc.font("R").fontSize(8).fillColor(DIM);
    let yy = y;
    for (const line of lines) {
      doc.text(line, x, yy, { width: w, align: "right", lineBreak: false });
      yy += 12;
    }
    return yy;
  }

  function drawFirstHeader(sectionTitle) {
    const w = contentWidth();
    const heading = sectionTitle || title;
    let size = 15;
    doc.font("B");
    while (size > 9 && doc.fontSize(size).widthOfString(heading) > w * 0.56) size -= 0.5;
    doc.font("B").fontSize(size).fillColor(INK).text(heading, margin, margin, { width: w * 0.58, lineBreak: false });
    doc.font("R").fontSize(9).fillColor(DIM).text(`Վավեր է մինչև ${formatValidUntil(validUntil)}`, margin, margin + 24, { width: w * 0.58, lineBreak: false });
    const endY = drawContactBox(margin + w * 0.55, margin, w * 0.45);
    doc.y = Math.max(endY, margin + 42) + 8;
  }

  function drawSmallHeader(sectionTitle) {
    doc.font("B").fontSize(9).fillColor(DIM).text(sectionTitle || title, margin, margin - 6, { width: contentWidth(), lineBreak: false });
    doc.y = margin + 10;
  }

  let headerDrawn = false;
  function pageHeader(sectionTitle) {
    if (!headerDrawn) {
      drawFirstHeader(sectionTitle);
      headerDrawn = true;
    } else {
      drawSmallHeader(sectionTitle);
    }
  }

  // ---- generic table machinery -----------------------------------------
  function drawTableHeader(columnDefs) {
    const y = doc.y;
    const h = 26;
    doc.save().rect(margin, y, contentWidth(), h).fill(BAND).restore();
    let x = margin;
    doc.font("B").fontSize(7.5).fillColor("#ffffff");
    for (const c of columnDefs) {
      doc.text(c.label, x + 4, y + 4, { width: c.width - 8, align: c.align, lineGap: 1 });
      x += c.width;
    }
    doc.y = y + h;
  }

  let currentColumns = null;
  let currentSectionTitle = null;
  function newPage(layout) {
    doc.addPage({ size: "A4", layout, margin });
    pageHeader(currentSectionTitle);
    if (currentColumns) drawTableHeader(currentColumns);
  }
  function ensureSpace(h, layout) {
    if (doc.y + h > bottomLimit()) newPage(layout);
  }

  function drawBrandBand(brand, layout) {
    ensureSpace(60, layout);
    const y = doc.y + 4;
    doc.save().rect(margin, y, contentWidth(), 18).fill("#e8eaee").restore();
    doc.font("B").fontSize(10).fillColor(INK).text(String(brand).toUpperCase(), margin + 6, y + 4, { width: contentWidth() - 12, lineBreak: false });
    doc.y = y + 18;
    if (currentColumns) drawTableHeader(currentColumns);
  }

  // ---- passenger sections (portrait) --------------------------------------
  function portraitColumns() {
    const priceW = 62;
    const photoW = includePhotos ? 46 : 0;
    const volW = 50;
    const nameW = contentWidth() - photoW - volW - priceW * cols.length;
    const defs = [];
    if (includePhotos) defs.push({ key: "photo", label: "Նկար", width: photoW, align: "center" });
    defs.push({ key: "name", label: "Անվանում", width: nameW, align: "left" });
    defs.push({ key: "vol", label: "Ծավալ", width: volW, align: "center" });
    for (const c of cols) defs.push({ key: c, label: TIER_COLUMNS[c].label, width: priceW, align: "right" });
    return defs;
  }

  function drawGroup(group, defs, zebra) {
    const photoBuf = includePhotos ? loadImage(imageCache, uploadDir, group.items.map((p) => p.image_path).find(Boolean)) : null;
    const nameDef = defs.find((d) => d.key === "name");
    doc.font("B").fontSize(8.5);
    const nameH = doc.heightOfString(group.name, { width: nameDef.width - 10 }) + 8;
    const minGroupH = Math.max(photoBuf ? 44 : 0, nameH, 18 * group.items.length);
    const rowH = Math.ceil(minGroupH / group.items.length);
    const groupH = rowH * group.items.length;
    ensureSpace(groupH);
    const y0 = doc.y;
    if (zebra) doc.save().rect(margin, y0, contentWidth(), groupH).fill(ZEBRA).restore();

    let x = margin;
    for (const d of defs) {
      if (d.key === "photo" && photoBuf) {
        try {
          doc.image(photoBuf, x + 3, y0 + 3, { fit: [d.width - 6, groupH - 6], align: "center", valign: "center" });
        } catch {
          // unreadable image: leave the cell empty
        }
      } else if (d.key === "name") {
        doc.font("B").fontSize(8.5).fillColor(INK);
        const h = doc.heightOfString(group.name, { width: d.width - 10 });
        doc.text(group.name, x + 5, y0 + (groupH - h) / 2, { width: d.width - 10 });
      }
      x += d.width;
    }
    group.items.forEach((p, i) => {
      const yy = y0 + i * rowH;
      let xx = margin;
      for (const d of defs) {
        if (d.key === "vol") {
          doc.font("R").fontSize(8.5).fillColor(INK).text(formatVolume(p.unit), xx + 2, yy + (rowH - 9) / 2, { width: d.width - 4, align: "center", lineBreak: false });
        } else if (TIER_COLUMNS[d.key]) {
          const value = TIER_COLUMNS[d.key].get(p);
          doc.font(d.key === "retail" ? "R" : "B").fontSize(8.5).fillColor(value == null ? DIM : INK).text(formatPrice(value), xx + 2, yy + (rowH - 9) / 2, { width: d.width - 6, align: "right", lineBreak: false });
        }
        xx += d.width;
      }
      if (i > 0) doc.save().moveTo(margin + (defs[0].key === "photo" ? defs[0].width : 0), yy).lineTo(margin + contentWidth(), yy).lineWidth(0.3).stroke(LINE).restore();
    });
    doc.save().moveTo(margin, y0 + groupH).lineTo(margin + contentWidth(), y0 + groupH).lineWidth(0.5).stroke(LINE).restore();
    doc.y = y0 + groupH;
  }

  // ---- commercial section (landscape) -----------------------------------------
  function commercialColumns() {
    // Like the Excel's commercial sheet: tier prices + per-litre, no retail column.
    const showTier = cols.filter((c) => c === "bronze" || c === "silver" || c === "gold");
    const priceW = 58;
    const perLitreW = 52;
    const volW = 46;
    const nameW = 140;
    const w = doc.page.width - margin * 2;
    const techW = w - nameW - volW - priceW * showTier.length - perLitreW * showTier.length;
    const defs = [
      { key: "name", label: "Անվանում", width: nameW, align: "left" },
      { key: "tech", label: "Տեխնիկական տվյալներ", width: techW, align: "left" },
      { key: "vol", label: "Ծավալ", width: volW, align: "center" },
    ];
    for (const c of showTier) defs.push({ key: c, label: TIER_COLUMNS[c].label, width: priceW, align: "right" });
    for (const c of showTier) defs.push({ key: `${c}_l`, label: `${TIER_COLUMNS[c].title}\nԴրամ / լ`, width: perLitreW, align: "right", tier: c });
    return defs;
  }

  function techText(p) {
    const parts = [];
    if (p.description) parts.push(String(p.description));
    const specs = Array.isArray(p.specs) ? p.specs.filter((s) => s?.label && s?.value) : [];
    if (specs.length) parts.push(specs.map((s) => `${s.label} ${s.value}`).join(" · "));
    if (Array.isArray(p.approvals) && p.approvals.length) parts.push(`Հավանություններ՝ ${p.approvals.join(" · ")}`);
    return parts.join("\n");
  }

  function drawCommercialGroup(group, defs, zebra) {
    const techDef = defs.find((d) => d.key === "tech");
    const tech = techText(group.items.find((p) => techText(p)) || {});
    doc.font("R").fontSize(6.5);
    const techH = tech ? Math.min(96, doc.heightOfString(tech, { width: techDef.width - 10, lineGap: 0.5 }) + 8) : 0;
    doc.font("B").fontSize(8.5);
    const nameH = doc.heightOfString(group.name, { width: defs[0].width - 10 }) + 8;
    const minGroupH = Math.max(techH, nameH, 18 * group.items.length);
    const rowH = Math.ceil(minGroupH / group.items.length);
    const groupH = rowH * group.items.length;
    ensureSpace(groupH, "landscape");
    const y0 = doc.y;
    if (zebra) doc.save().rect(margin, y0, contentWidth(), groupH).fill(ZEBRA).restore();
    let x = margin;
    for (const d of defs) {
      if (d.key === "name") {
        doc.font("B").fontSize(8.5).fillColor(INK);
        const h = doc.heightOfString(group.name, { width: d.width - 10 });
        doc.text(group.name, x + 5, y0 + (groupH - h) / 2, { width: d.width - 10 });
      } else if (d.key === "tech" && tech) {
        doc.font("R").fontSize(6.5).fillColor(DIM).text(tech, x + 5, y0 + 4, { width: d.width - 10, height: groupH - 6, lineGap: 0.5, ellipsis: true });
      }
      x += d.width;
    }
    group.items.forEach((p, i) => {
      const yy = y0 + i * rowH;
      let xx = margin;
      const liters = parseLiters(p.unit);
      for (const d of defs) {
        const ty = yy + (rowH - 9) / 2;
        if (d.key === "vol") {
          doc.font("R").fontSize(8.5).fillColor(INK).text(formatVolume(p.unit), xx + 2, ty, { width: d.width - 4, align: "center", lineBreak: false });
        } else if (TIER_COLUMNS[d.key]) {
          const value = TIER_COLUMNS[d.key].get(p);
          doc.font(d.key === "retail" ? "R" : "B").fontSize(8.5).fillColor(value == null ? DIM : INK).text(formatPrice(value), xx + 2, ty, { width: d.width - 6, align: "right", lineBreak: false });
        } else if (d.tier) {
          const value = TIER_COLUMNS[d.tier].get(p);
          const perL = value != null && liters ? value / liters : null;
          doc.font("R").fontSize(8).fillColor(DIM).text(formatPrice(perL), xx + 2, ty, { width: d.width - 6, align: "right", lineBreak: false });
        }
        xx += d.width;
      }
      if (i > 0) doc.save().moveTo(margin + defs[0].width + defs[1].width, yy).lineTo(margin + contentWidth(), yy).lineWidth(0.3).stroke(LINE).restore();
    });
    doc.save().moveTo(margin, y0 + groupH).lineTo(margin + contentWidth(), y0 + groupH).lineWidth(0.5).stroke(LINE).restore();
    doc.y = y0 + groupH;
  }

  // ---- compose ----------------------------------------------------------------
  let first = true;

  const brands = brandOrder([...new Set(regular.map((p) => p.brand || "").filter(Boolean))]);
  if (brands.length) {
    currentColumns = portraitColumns();
    currentSectionTitle = null;
    pageHeader(null);
    first = false;
    for (const brand of brands) {
      drawBrandBand(brand);
      groupByModel(regular.filter((p) => (p.brand || "") === brand)).forEach((g, i) => drawGroup(g, currentColumns, i % 2 === 1));
      doc.y += 6;
    }
  }

  if (commercial.length) {
    currentSectionTitle = `Կոմերցիոն յուղեր  ·  ${tierTitles.join("  ·  ")}`.replace(/\s+·\s+$/, "");
    if (!first) doc.addPage({ size: "A4", layout: "landscape", margin });
    currentColumns = commercialColumns();
    pageHeader(currentSectionTitle);
    for (const brand of brandOrder([...new Set(commercial.map((p) => p.brand || "").filter(Boolean))])) {
      drawBrandBand(brand, "landscape");
      groupByModel(commercial.filter((p) => (p.brand || "") === brand)).forEach((g, i) => drawCommercialGroup(g, currentColumns, i % 2 === 1));
      doc.y += 6;
    }
  }

  if (!brands.length && !commercial.length) {
    pageHeader(null);
    doc.font("R").fontSize(10).fillColor(DIM).text("—", margin, doc.y + 20);
  }

  // Page numbers (written after layout so the total is known).
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const prevBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("R").fontSize(7).fillColor(DIM);
    doc.text(`${i + 1} / ${range.count}`, margin, doc.page.height - 22, { width: doc.page.width - margin * 2, align: "center", lineBreak: false });
    doc.page.margins.bottom = prevBottom;
  }
  return doc;
}
