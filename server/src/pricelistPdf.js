// Pricelist PDF (Armenian), laid out like the company's KF_Pricelist_*.xlsx:
// one section per sheet -- Castrol (green), Lotos & Orlen (navy), Royal
// (black) and a landscape "Commercial oils" section (graphite) -- each with a
// logo strip, a coloured title band (title + valid-until on the left, the
// contact block on the right), an accent stripe, then the table: photo, name,
// volume, BRONZE / SILVER (tinted columns) and retail. Generated per user: a
// sales manager's contact block shows their own name/phone/email plus the
// office line, management's shows the office details only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { compareProducts, parseLiters, BRAND_PRIORITY } from "../../client/public/js/productSort.js";

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

export const OFFICE_PHONE = "091-007-019";

const TIER_COLUMNS = {
  bronze: { label: "BRONZE\nԴրամ", title: "Bronze", head: "#C9915C", fill: "#F1E2D3", get: (p) => num(p.bronze_price_amd) ?? num(p.unit_price_amd) },
  silver: { label: "SILVER\nԴրամ", title: "Silver", head: "#AEB6BF", fill: "#E3E6EA", get: (p) => num(p.silver_price_amd) },
  gold: { label: "GOLD\nԴրամ", title: "Gold", head: "#D8B24C", fill: "#F6EBC8", get: (p) => num(p.gold_price_amd) },
  retail: { label: "Մանրածախ\nԴրամ", title: null, plain: true, get: (p) => num(p.effective_retail_amd ?? p.retail_price_amd) },
  // Internal cost columns (admin / CEO / operations director only -- the route enforces it).
  landing: { label: "LANDING\nԴրամ", title: null, internal: true, head: "#CBD2D9", fill: "#EEF1F4", get: (p) => num(p.landing_cost_amd) },
  net: { label: "NET COST\nԴրամ", title: null, internal: true, head: "#CBD2D9", fill: "#EEF1F4", get: (p) => num(p.net_cost_amd) },
};
export const PDF_COLUMN_ORDER = ["bronze", "silver", "gold", "retail", "landing", "net"];
export const PDF_INTERNAL_COLUMNS = ["landing", "net"];

// Section look, taken from the workbook's sheets.
const SECTIONS = {
  castrol: { band: "#00693E", stripe: "#C8102E", head: "#00693E", brandBand: null, logos: ["castrol"] },
  lotos: { band: "#0B2A5B", stripe: "#F2A900", head: "#0B2A5B", brandBand: "#0B2A5B", logos: ["lotos", "orlen"] },
  royal: { band: "#1A1A1A", stripe: "#B8860B", head: "#1A1A1A", brandBand: null, logos: ["royal"] },
  other: { band: "#2B2B2B", stripe: "#F28C00", head: "#2B2B2B", brandBand: "#2B2B2B", logos: [] },
  commercial: { band: "#2B2B2B", stripe: "#F28C00", head: "#2B2B2B", brandBand: "#2B2B2B", logos: ["castrol", "lotos", "orlen", "royal"], landscape: true },
};
// Logo size in points (the workbook's own sizes) and, where a sheet carries
// several logos, their x offsets (pt) from the left margin.
const LOGO_SIZE = { castrol: [112, 26], lotos: [112, 19.5], orlen: [67.5, 27], royal: [106, 27] };
const LOGO_X = {
  lotos: { lotos: 3, orlen: 3 + 63.6 + 66.8 },
  commercial: { castrol: 3, lotos: 3 + 133.5, orlen: 3 + 142 + 113, royal: 3 + 142 + 199 },
};

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

// Which workbook-style section a (non-commercial) brand belongs to.
function sectionKeyForBrand(brand) {
  if (brand === "Castrol") return "castrol";
  if (brand === "Lotos" || brand === "Orlen") return "lotos";
  if (brand === "Royal") return "royal";
  return "other";
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
  const hasInternal = cols.some((c) => TIER_COLUMNS[c].internal);
  const title = `Մեծածախ գնացուցակ${tierTitles.length ? `  ·  ${tierTitles.join("  ·  ")}` : ""}`;
  const imageCache = new Map();
  const logoCache = new Map();
  const logo = (key) => {
    if (!logoCache.has(key)) {
      try {
        logoCache.set(key, fs.readFileSync(path.join(ASSET_DIR, "logos", `${key}.png`)));
      } catch {
        logoCache.set(key, null);
      }
    }
    return logoCache.get(key);
  };

  // ---- what goes into which section -----------------------------------------
  const regular = products.filter((p) => !p.is_commercial);
  const commercial = includeCommercial && cols.some((c) => c !== "retail") ? products.filter((p) => p.is_commercial) : [];
  const sections = [];
  const byKey = new Map();
  for (const brand of brandOrder([...new Set(regular.map((p) => p.brand || "").filter(Boolean))])) {
    const key = sectionKeyForBrand(brand);
    if (!byKey.has(key)) {
      const sec = { key, brands: [], products: [] };
      byKey.set(key, sec);
      sections.push(sec);
    }
    const sec = byKey.get(key);
    sec.brands.push(brand);
    sec.products.push(...regular.filter((p) => (p.brand || "") === brand));
  }
  if (commercial.length) {
    const brands = brandOrder([...new Set(commercial.map((p) => p.brand || "").filter(Boolean))]);
    sections.push({ key: "commercial", brands, products: commercial });
  }

  const startLandscape = sections[0]?.key === "commercial";
  const margin = 29; // 0.4in, as in the workbook's page setup
  const doc = new PDFDocument({ size: "A4", layout: startLandscape ? "landscape" : "portrait", margin, bufferPages: true, info: { Title: title, Author: "KAD Motors" } });
  doc.registerFont("R", path.join(ASSET_DIR, "fonts", "DejaVuSans.ttf"));
  doc.registerFont("B", path.join(ASSET_DIR, "fonts", "DejaVuSans-Bold.ttf"));

  const INK = "#1F2933";
  const SOFT = "#3E4C59";
  const MUTED = "#7A8591";
  const LINE = "#E3E7EB";
  const contentWidth = () => doc.page.width - margin * 2;
  const bottomLimit = () => doc.page.height - margin;

  // ---- section header: logo strip + band + stripe -------------------------
  function drawSectionHeader(spec, sectionTitle, subtitle) {
    const w = contentWidth();
    const top = margin;
    // logo strip (46pt, white)
    for (const key of spec.logos) {
      const buf = logo(key);
      const [lw, lh] = LOGO_SIZE[key];
      const xs = spec.landscape ? LOGO_X.commercial : spec.logos.length > 1 ? LOGO_X.lotos : {};
      if (buf) doc.image(buf, margin + (xs[key] ?? 3), top + (46 - lh) / 2, { width: lw, height: lh });
    }
    // band: 24 + 19 + 19 pt
    const bandTop = top + 46;
    doc.save().rect(margin, bandTop, w, 62).fill(spec.band).restore();
    // Contact lines (right block) -- built first so the title can shrink to the space left of them.
    const right = [];
    if (contact.mode === "rep" && contact.name) right.push({ text: `Վաճառքի մենեջեր՝ ${contact.name}`, bold: true });
    else right.push({ text: "KAD Motors", bold: true });
    if (contact.email) right.push({ text: `Էլ. հասցե՝ ${contact.email}` });
    const phones = [];
    if (contact.mode === "rep" && contact.phone) phones.push(`Հեռ.՝ ${contact.phone}`);
    phones.push(`Գրասենյակ՝ ${contact.officePhone || OFFICE_PHONE}`);
    right.push({ text: phones.join(" | ") });
    const rightWidth = Math.max(...right.map((l) => doc.font(l.bold ? "B" : "R").fontSize(l.bold ? 10 : 9).widthOfString(l.text)));
    const leftMax = Math.max(120, w - rightWidth - 40);
    // Title: shrink to fit the space left of the contact block (never wraps into it).
    let titleSize = 14;
    doc.font("B");
    while (titleSize > 8 && doc.fontSize(titleSize).widthOfString(sectionTitle) > leftMax) titleSize -= 0.5;
    doc.font("B").fontSize(titleSize).fillColor("#FFFFFF").text(sectionTitle, margin + 8, bandTop + 6, { width: w * 0.6, lineBreak: false });
    doc.font("R").fontSize(9);
    if (subtitle) doc.text(subtitle, margin + 8, bandTop + 27, { width: w * 0.56, lineBreak: false });
    doc.text(`Վավեր է մինչև ${formatValidUntil(validUntil)}`, margin + 8, bandTop + (subtitle ? 43 : 30), { width: w * 0.56, lineBreak: false });
    let ry = bandTop + 6;
    for (const line of right) {
      doc.font(line.bold ? "B" : "R").fontSize(line.bold ? 10 : 9).fillColor("#FFFFFF").text(line.text, margin + w * 0.4, ry, { width: w * 0.6 - 8, align: "right", lineBreak: false });
      ry += line.bold ? 21 : 19;
    }
    if (hasInternal) {
      doc.font("B").fontSize(7.5).fillColor("#FFD2D2").text("ՆԵՐՔԻՆ ՕԳՏԱԳՈՐԾՄԱՆ ՀԱՄԱՐ — ՉՏԱԼ ՀԱՃԱԽՈՐԴՆԵՐԻՆ", margin + 8, bandTop + 52, { width: w * 0.56, lineBreak: false });
    }
    // accent stripe (4pt) + spacer (8pt)
    doc.save().rect(margin, bandTop + 62, w, 4).fill(spec.stripe).restore();
    doc.y = bandTop + 62 + 4 + 8;
  }

  // ---- table plumbing -----------------------------------------------------
  let table = null; // { spec, columns:[{key,label,width,align,...}], landscape }
  function drawTableHeader() {
    const y = doc.y;
    const h = 36;
    let x = margin;
    for (const c of table.columns) {
      const tier = TIER_COLUMNS[c.key];
      if (tier?.head) doc.save().rect(x, y, c.width, h).fill(tier.head).restore();
      doc.font("B").fontSize(tier?.head ? 10.5 : 9).fillColor(tier?.head ? INK : table.spec.head);
      const th = doc.heightOfString(c.label, { width: c.width - 8, align: c.align });
      doc.text(c.label, x + 4, y + (h - th) / 2, { width: c.width - 8, align: c.align });
      x += c.width;
    }
    doc.save().moveTo(margin, y + h).lineTo(margin + contentWidth(), y + h).lineWidth(1.4).stroke(table.spec.head).restore();
    doc.y = y + h;
  }
  function newPage() {
    doc.addPage({ size: "A4", layout: table.landscape ? "landscape" : "portrait", margin });
    doc.y = margin;
    drawTableHeader();
  }
  function ensureSpace(h) {
    if (doc.y + h > bottomLimit()) newPage();
  }
  function drawBrandBand(brand) {
    const spec = table.spec;
    if (!spec.brandBand) return;
    ensureSpace(22 + 40);
    const y = doc.y;
    doc.save().rect(margin, y, contentWidth(), 22).fill("#E8ECF1").restore();
    doc.save().moveTo(margin, y + 22).lineTo(margin + contentWidth(), y + 22).lineWidth(0.5).stroke(LINE).restore();
    doc.font("B").fontSize(10.5).fillColor(spec.brandBand).text(String(brand).toUpperCase(), margin + 8, y + 6, { width: contentWidth() - 16, lineBreak: false });
    doc.y = y + 22;
  }

  // Column widths in workbook "characters", scaled to the page.
  function layoutColumns(units) {
    const total = units.reduce((a, u) => a + u.w, 0);
    return units.map((u) => ({ ...u, width: (contentWidth() * u.w) / total }));
  }

  // ---- passenger-car sections ------------------------------------------------
  function passengerColumns() {
    const units = [];
    if (includePhotos) units.push({ key: "photo", label: "Նկար", w: 12, align: "center" });
    units.push({ key: "name", label: "Անվանում", w: 33, align: "left" });
    units.push({ key: "vol", label: "Ծավալ", w: 8, align: "center" });
    for (const c of cols) units.push({ key: c, label: TIER_COLUMNS[c].label, w: 16, align: "right" });
    return layoutColumns(units);
  }

  function priceCell(x, y, w, h, key, value, bold) {
    const tier = TIER_COLUMNS[key];
    if (tier?.fill) {
      doc.save().rect(x, y, w, h).fill(tier.fill).restore();
      doc.save().rect(x, y, w, h).lineWidth(0.5).stroke(LINE).restore();
    }
    const size = bold ? 12 : 9.5;
    doc.font(bold ? "B" : "R").fontSize(size).fillColor(value == null ? MUTED : tier?.fill ? INK : SOFT).text(formatPrice(value), x + 3, y + (h - size) / 2 - 1, { width: w - 9, align: "right", lineBreak: false });
  }

  function drawPassengerGroup(group) {
    const photoBuf = includePhotos ? loadImage(imageCache, uploadDir, group.items.map((p) => p.image_path).find(Boolean)) : null;
    const nameCol = table.columns.find((c) => c.key === "name");
    doc.font("B").fontSize(9.7);
    const nameH = doc.heightOfString(group.name, { width: nameCol.width - 10 }) + 8;
    const minGroupH = Math.max(photoBuf ? 54 : 0, nameH, 21 * group.items.length);
    const rowH = Math.ceil(minGroupH / group.items.length);
    const groupH = rowH * group.items.length;
    ensureSpace(groupH);
    const y0 = doc.y;
    doc.save().lineWidth(0.5).strokeColor(LINE);
    doc.moveTo(margin, y0).lineTo(margin + contentWidth(), y0).stroke();
    doc.moveTo(margin, y0 + groupH).lineTo(margin + contentWidth(), y0 + groupH).stroke();
    doc.restore();
    let x = margin;
    for (const c of table.columns) {
      if (c.key === "photo" && photoBuf) {
        try {
          doc.image(photoBuf, x + 5, y0 + 4, { fit: [c.width - 10, groupH - 8], align: "center", valign: "center" });
        } catch {
          // unreadable image: leave the cell empty
        }
      } else if (c.key === "name") {
        doc.font("B").fontSize(9.7).fillColor(INK);
        const h = doc.heightOfString(group.name, { width: c.width - 10 });
        doc.text(group.name, x + 5, y0 + (groupH - h) / 2, { width: c.width - 10 });
      }
      x += c.width;
    }
    group.items.forEach((p, i) => {
      const yy = y0 + i * rowH;
      let xx = margin;
      for (const c of table.columns) {
        if (c.key === "vol") {
          doc.save().moveTo(xx, yy).lineTo(xx + c.width, yy).lineWidth(0.5).stroke(LINE).restore();
          doc.font("R").fontSize(9.7).fillColor(INK).text(formatVolume(p.unit), xx + 2, yy + (rowH - 10) / 2, { width: c.width - 4, align: "center", lineBreak: false });
        } else if (TIER_COLUMNS[c.key]) {
          priceCell(xx, yy, c.width, rowH, c.key, TIER_COLUMNS[c.key].get(p), Boolean(TIER_COLUMNS[c.key].fill));
        }
        xx += c.width;
      }
    });
    doc.y = y0 + groupH;
  }

  // ---- commercial section (landscape) -----------------------------------------
  function commercialColumns() {
    const tiers = cols.filter((c) => TIER_COLUMNS[c].fill && !TIER_COLUMNS[c].internal);
    const priceCols = cols.filter((c) => c !== "retail");
    const units = [
      { key: "name", label: "Անվանում", w: 28, align: "left" },
      { key: "tech", label: "Տեխնիկական տվյալներ", w: 62, align: "left" },
      { key: "vol", label: "Ծավալ", w: 8, align: "center" },
    ];
    for (const c of priceCols) units.push({ key: c, label: TIER_COLUMNS[c].label, w: 16, align: "right" });
    for (const c of tiers) units.push({ key: `${c}_l`, label: `${TIER_COLUMNS[c].title}\nԴրամ / լ`, w: 12, align: "right", tier: c });
    return layoutColumns(units);
  }

  function techText(p) {
    const parts = [];
    if (p.description) parts.push(String(p.description));
    const specs = Array.isArray(p.specs) ? p.specs.filter((s) => s?.label && s?.value) : [];
    if (specs.length) parts.push(specs.map((s) => `${s.label} ${s.value}`).join(" · "));
    if (Array.isArray(p.approvals) && p.approvals.length) parts.push(`Հավանություններ՝ ${p.approvals.join(" · ")}`);
    return parts.join("\n");
  }

  function drawCommercialGroup(group) {
    const techCol = table.columns.find((c) => c.key === "tech");
    const nameCol = table.columns.find((c) => c.key === "name");
    const tech = techText(group.items.find((p) => techText(p)) || {});
    doc.font("R").fontSize(7.2);
    const techH = tech ? Math.min(110, doc.heightOfString(tech, { width: techCol.width - 12, lineGap: 0.5 }) + 10) : 0;
    doc.font("B").fontSize(9.7);
    const nameH = doc.heightOfString(group.name, { width: nameCol.width - 10 }) + 8;
    const minGroupH = Math.max(techH, nameH, 21 * group.items.length);
    const rowH = Math.ceil(minGroupH / group.items.length);
    const groupH = rowH * group.items.length;
    ensureSpace(groupH);
    const y0 = doc.y;
    doc.save().lineWidth(0.5).strokeColor(LINE);
    doc.moveTo(margin, y0).lineTo(margin + contentWidth(), y0).stroke();
    doc.moveTo(margin, y0 + groupH).lineTo(margin + contentWidth(), y0 + groupH).stroke();
    doc.restore();
    let x = margin;
    for (const c of table.columns) {
      if (c.key === "name") {
        doc.font("B").fontSize(9.7).fillColor(INK);
        const h = doc.heightOfString(group.name, { width: c.width - 10 });
        doc.text(group.name, x + 5, y0 + (groupH - h) / 2, { width: c.width - 10 });
      } else if (c.key === "tech" && tech) {
        doc.font("R").fontSize(7.2).fillColor("#2D3A45").text(tech, x + 6, y0 + 5, { width: c.width - 12, height: groupH - 8, lineGap: 0.5, ellipsis: true });
      }
      x += c.width;
    }
    group.items.forEach((p, i) => {
      const yy = y0 + i * rowH;
      let xx = margin;
      const liters = parseLiters(p.unit);
      for (const c of table.columns) {
        if (c.key === "vol") {
          doc.save().moveTo(xx, yy).lineTo(xx + c.width, yy).lineWidth(0.5).stroke(LINE).restore();
          doc.font("R").fontSize(9.7).fillColor(INK).text(formatVolume(p.unit), xx + 2, yy + (rowH - 10) / 2, { width: c.width - 4, align: "center", lineBreak: false });
        } else if (TIER_COLUMNS[c.key]) {
          priceCell(xx, yy, c.width, rowH, c.key, TIER_COLUMNS[c.key].get(p), Boolean(TIER_COLUMNS[c.key].fill));
        } else if (c.tier) {
          const value = TIER_COLUMNS[c.tier].get(p);
          const perL = value != null && liters ? value / liters : null;
          doc.font("R").fontSize(9.5).fillColor(MUTED).text(formatPrice(perL), xx + 2, yy + (rowH - 10) / 2, { width: c.width - 8, align: "right", lineBreak: false });
        }
        xx += c.width;
      }
    });
    doc.y = y0 + groupH;
  }

  // ---- compose --------------------------------------------------------------------
  sections.forEach((sec, index) => {
    const spec = SECTIONS[sec.key];
    if (index > 0) doc.addPage({ size: "A4", layout: spec.landscape ? "landscape" : "portrait", margin });
    const isCommercial = sec.key === "commercial";
    drawSectionHeader(spec, isCommercial ? "Կոմերցիոն յուղեր" : title, isCommercial ? title : null);
    table = { spec, landscape: Boolean(spec.landscape), columns: isCommercial ? commercialColumns() : passengerColumns() };
    drawTableHeader();
    for (const brand of sec.brands) {
      // A lone-brand sheet (Castrol, Royal) has no brand band, like the workbook.
      if (sec.brands.length > 1 || isCommercial || sec.key === "other") drawBrandBand(brand);
      const groups = groupByModel(sec.products.filter((p) => (p.brand || "") === brand));
      for (const g of groups) (isCommercial ? drawCommercialGroup : drawPassengerGroup)(g);
    }
  });

  if (!sections.length) drawSectionHeader(SECTIONS.other, title, null);
  return doc;
}
