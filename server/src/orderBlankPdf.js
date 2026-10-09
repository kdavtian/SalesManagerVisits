// Print-ready "Delivery-acceptance act" (ՀԱՆՁՆՄԱՆ-ԸՆԴՈՒՆՄԱՆ ԱԿՏ) for orders, laid
// out like the company's printed order blank: brand logos, company + manager
// contact lines, order number / date / customer / code, a numbered table
// (name, liters, qty, price, sum), TOTAL, the debt block (previous balance,
// order, payment, current balance) and the two signature lines.
//
// Two versions, to save paper:
//  - "full": one order on a whole A4 sheet (15 rows, more rows / a second page
//    for big orders);
//  - "half": a compact blank for a small order (up to HALF_MAX_ROWS lines) --
//    two of them share one A4 sheet, separated by a dashed cut line.
// The layouts are drawn in the blank's own units (US-letter points, 612 wide;
// 792 high for "full", 396 for "half") and scaled uniformly to A4.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
const logo = (name) => fs.readFileSync(path.join(ASSET_DIR, "logos", `ob-${name}.png`));

export const COMPANY_NAME = "Քալանթարյան Ֆեմիլի ՓԲԸ";
export const HALF_MAX_ROWS = 8;
export const FULL_MIN_ROWS = 15;
const FULL_PAGE_ROWS = 22;

const A4 = { w: 595.28, h: 841.89 };
const K = A4.w / 612;
const INK = "#111111";
const LINE = "#8A8A8A";
const SHADE = "#F1F1F1";
// Column edges (blank units): No | name | liters | qty | price | sum
const COLS = [21.6, 52.8, 326, 377.6, 435, 497.6, 589.6];

export function suggestVariant(items) {
  return items.length <= HALF_MAX_ROWS ? "half" : "full";
}

function amd(n) {
  if (n === null || n === undefined || n === "") return "";
  return Math.round(Number(n)).toLocaleString("en-US");
}

// Everything drawn for one blank, in blank units, inside the current transform.
function makeCanvas(doc) {
  const hline = (y, x1 = 21.6, x2 = 589.6, color = LINE, w = 0.6) => doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(w).strokeColor(color).stroke().restore();
  const textW = (s, o = {}) => doc.font(o.bold ? "B" : "R").fontSize(o.size ?? 10).widthOfString(String(s ?? ""));
  const text = (s, x, y, o = {}) => doc.font(o.bold ? "B" : "R").fontSize(o.size ?? 10).fillColor(INK).text(String(s ?? ""), x, y, { lineBreak: false });
  const right = (s, xr, y, o = {}) => text(s, xr - textW(s, o), y, o);
  const center = (s, x1, x2, y, o = {}) => text(s, x1 + (x2 - x1 - textW(s, o)) / 2, y, o);
  const fit = (s, width, size) => {
    let t = String(s ?? "");
    if (textW(t, { size }) <= width) return t;
    while (t.length > 1 && textW(`${t}…`, { size }) > width) t = t.slice(0, -1);
    return `${t}…`;
  };
  const field = (label, value, x, y, lineEnd, size = 10) => {
    text(label, x, y, { size });
    const lx = x + textW(label, { size }) + 4;
    if (value) text(value, lx + 2, y, { bold: true, size });
    hline(y + size + 1, lx, lineEnd, value ? "#999999" : "#555555", value ? 0.4 : 0.5);
  };
  return { hline, text, textW, right, center, fit, field };
}

function dateParts(order) {
  // The order's Yerevan calendar date (the server runs in UTC).
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Yerevan", day: "2-digit", month: "2-digit", year: "numeric" }).formatToParts(new Date(order.created_at ?? Date.now()));
  const get = (t) => parts.find((x) => x.type === t).value;
  return { dd: get("day"), mm: get("month"), yyyy: get("year") };
}

function totals({ order, items, previousDebtAmd = null, paymentAmd = null }) {
  const sum = items.reduce((s, it) => s + Number(it.line_total_amd ?? Number(it.quantity) * Number(it.unit_price_amd)), 0);
  const orderTotal = order.total_amd != null ? Number(order.total_amd) : sum;
  const current = previousDebtAmd !== null && paymentAmd !== null ? Number(previousDebtAmd) + orderTotal - Number(paymentAmd) : null;
  return { sum, orderTotal, current };
}

function drawHeader(c, doc, { order, customer, rep }, v) {
  const { dd, mm, yyyy } = dateParts(order);
  const { hline, text, center, field, fit } = c;
  hline(v.rule1);
  text(COMPANY_NAME, 21.6, v.rule1 + 3.5, { size: v.fs });
  text(`Մենեջեր՝ ${rep?.name ?? ""}`, 21.6, v.rule1 + 3.5 + v.lh, { size: v.fs });
  const phones = (rep?.phones ?? []).filter(Boolean);
  text("Հեռ՝", 413, v.rule1 + 3.5, { size: v.fs });
  phones.slice(0, 2).forEach((p, i) => text(p, 448, v.rule1 + 3.5 + i * v.lh, { size: v.fs }));
  hline(v.rule2);
  field("Պատվերի No՝", order.order_code ?? "", 21.6, v.row1, 170, v.fs);
  text("Ամսաթիվ՝", 416, v.row1, { size: v.fs });
  center(dd, 468, 495, v.row1, { bold: true, size: v.fs });
  hline(v.row1 + v.fs + 1, 466, 497, "#555555", 0.5);
  text("/", 499, v.row1, { size: v.fs });
  center(mm, 505, 532, v.row1, { bold: true, size: v.fs });
  hline(v.row1 + v.fs + 1, 504, 534, "#555555", 0.5);
  text(`/ ${yyyy}թ.`, 537, v.row1, { size: v.fs });
  field("Գործընկերոջ անվանում՝", fit(customer?.name ?? "", 250, v.fs), 21.6, v.row2, 400, v.fs);
  field("Կոդ՝", customer?.erp_customer_id ?? "", 500, v.row2, 589.6, v.fs);
  const title = "ՀԱՆՁՆՄԱՆ-ԸՆԴՈՒՆՄԱՆ ԱԿՏ";
  center(title, 21.6, 589.6, v.title, { bold: true, size: v.fs + 1 });
  const tw = c.textW(title, { bold: true, size: v.fs + 1 });
  hline(v.title + v.fs + 5, (611.2 - tw) / 2, (611.2 + tw) / 2, INK, 0.8);
}

function drawTable(c, doc, chunk, startNo, rowCount, v) {
  const { hline, text, right, center, fit } = c;
  const top = v.tableTop;
  const bottom = top + v.headH + rowCount * v.rowH;
  doc.save().rect(COLS[0], top, COLS[6] - COLS[0], v.headH).fill("#E9E9E9").restore();
  ["Հ/Հ", "ՄԱՏԱԿԱՐԱՐՎԱԾ ԱՊՐԱՆՔԻ ԱՆՎԱՆՈՒՄ", "Չ/Մ\n(ԼԻՏՐ)", "ՔԱՆԱԿ", "ԳԻՆ", "ԳՈՒՄԱՐ"].forEach((h, i) => {
    const lines = h.split("\n");
    const hs = v.fs - 1.5;
    const y0 = top + (v.headH - lines.length * (hs + 1.5)) / 2 + 0.5;
    lines.forEach((l, li) => center(l, COLS[i], COLS[i + 1], y0 + li * (hs + 1.5), { bold: true, size: hs }));
  });
  for (let r = 0; r < rowCount; r++) {
    const y = top + v.headH + r * v.rowH;
    if (r % 2 === 0) doc.save().rect(COLS[0], y, COLS[6] - COLS[0], v.rowH).fill(SHADE).restore();
    const it = chunk[r];
    const ty = y + (v.rowH - v.cs) / 2;
    text(String(startNo + r), COLS[0] + 3, ty, { size: v.cs });
    if (it) {
      const name = [it.brand, it.product_name].filter(Boolean).join(" ").replace(/\s+/g, " ");
      text(fit(name, COLS[2] - COLS[1] - 8, v.cs), COLS[1] + 4, ty, { size: v.cs });
      const liters = it.size_l != null && it.size_l !== "" ? String(it.size_l).replace(/L$/i, "") : "";
      center(liters, COLS[2], COLS[3], ty, { size: v.cs });
      center(String(Number(it.quantity)), COLS[3], COLS[4], ty, { size: v.cs });
      right(amd(it.unit_price_amd), COLS[5] - 5, ty, { size: v.cs });
      right(amd(it.line_total_amd ?? Number(it.quantity) * Number(it.unit_price_amd)), COLS[6] - 5, ty, { size: v.cs });
    }
  }
  doc.save().rect(COLS[0], top, COLS[6] - COLS[0], bottom - top).lineWidth(0.8).strokeColor("#555555").stroke().restore();
  hline(top + v.headH, COLS[0], COLS[6], "#555555", 0.8);
  for (let r = 1; r < rowCount; r++) hline(top + v.headH + r * v.rowH, COLS[0], COLS[6], "#C4C4C4", 0.4);
  COLS.forEach((x) => doc.save().moveTo(x, top).lineTo(x, bottom).lineWidth(0.6).strokeColor(LINE).stroke().restore());
  return bottom;
}

function drawTotal(c, doc, y, sum, h, fs) {
  doc.save().rect(COLS[0], y, COLS[6] - COLS[0], h).lineWidth(0.8).strokeColor("#555555").stroke().restore();
  c.text("ԸՆԴԱՄԵՆԸ՝", COLS[0] + 3, y + (h - fs) / 2, { bold: true, size: fs });
  c.right(amd(sum), COLS[6] - 5, y + (h - fs) / 2, { bold: true, size: fs });
}

function drawSignatures(c, data, y, fs) {
  const { field, center, textW } = c;
  field("Հանձնեց՝", data.rep?.name ?? "", 21.6, y, 345, fs);
  field("Ընդունեց՝", "", 379, y, 589.6, fs);
  center("ստորագրություն", 21.6 + textW("Հանձնեց՝", { size: fs }) + 4, 345, y + fs + 4, { size: 7 });
  center("ստորագրություն", 379 + textW("Ընդունեց՝", { size: fs }) + 4, 589.6, y + fs + 4, { size: 7 });
}

// Castrol, Lotos and Royal Super on one line: same height, centred on the same
// horizontal axis, first flush with the left edge, last with the right edge and
// the middle one equally spaced between them.
const LOGO_ASPECT = { castrol: 558 / 148, lotos: 452 / 113, royal: 401 / 105 };
function drawLogos(doc, cy, h) {
  const names = ["castrol", "lotos", "royal"];
  const widths = names.map((n) => h * LOGO_ASPECT[n]);
  const gap = (COLS[6] - COLS[0] - widths.reduce((a, b) => a + b, 0)) / 2;
  let x = COLS[0];
  names.forEach((n, i) => {
    doc.image(logo(n), x, cy - h / 2, { width: widths[i], height: h });
    x += widths[i] + gap;
  });
}

// ---- FULL: one order per A4 sheet (several sheets when it has many lines) -------------
function drawFull(doc, data, firstPageDrawn) {
  const { items } = data;
  const pages = [];
  for (let i = 0; i < items.length; i += FULL_PAGE_ROWS) pages.push(items.slice(i, i + FULL_PAGE_ROWS));
  if (!pages.length) pages.push([]);
  const t = totals(data);
  pages.forEach((chunk, pi) => {
    if (pi > 0 || firstPageDrawn) doc.addPage({ size: "A4", margin: 0 });
    const last = pi === pages.length - 1;
    doc.save();
    doc.scale(K);
    const c = makeCanvas(doc);
    drawLogos(doc, 43, 40);
    const v = { rule1: 81.5, rule2: 114, row1: 138, row2: 170, title: 213, fs: 10, lh: 13, cs: 9, tableTop: 249, headH: 28 };
    drawHeader(c, doc, data, v);
    const rowCount = Math.max(FULL_MIN_ROWS, chunk.length);
    v.rowH = Math.min(20.7, (last ? 612 - v.tableTop - v.headH - 22 : 700 - v.tableTop - v.headH) / rowCount);
    const bottom = drawTable(c, doc, chunk, pi * FULL_PAGE_ROWS + 1, rowCount, v);
    if (last) {
      drawTotal(c, doc, bottom, t.sum, 22, 10);
      const y = bottom + 22 + 22;
      [["Պարտքի նախկին մնացորդ՝", data.previousDebtAmd ?? null], ["Պատվեր՝", t.orderTotal], ["Վճարում՝", data.paymentAmd ?? null], ["Պարտքի ներկա մնացորդ՝", t.current]].forEach(([label, value], i) => {
        const ry = y + i * 21;
        if (i % 2 === 1 || i === 3) doc.save().rect(21.6, ry - 3, 568, 21).fill(SHADE).restore();
        c.text(label, 24.6, ry + 1, { bold: true, size: 10 });
        if (value !== null && value !== undefined) c.right(amd(value), 580, ry + 1, { bold: true, size: 10 });
        else c.hline(ry + 12, 215, 589, "#555555", 0.5);
      });
      drawSignatures(c, data, y + 4 * 21 + 38, 10);
    } else {
      c.text("Շարունակությունը հաջորդ էջում…", 21.6, bottom + 8, { size: 9 });
    }
    doc.restore();
  });
}

// ---- HALF: compact blank, drawn in a 612 x 396 box at slot offset ------------------------
function drawHalf(doc, data, slotTop, slotH) {
  const t = totals(data);
  doc.save();
  doc.translate(0, slotTop + (slotH - 396 * K) / 2);
  doc.scale(K);
  const c = makeCanvas(doc);
  drawLogos(doc, 24, 25);
  const v = { rule1: 46, rule2: 76, row1: 83, row2: 100, title: 119, fs: 8.5, lh: 11, cs: 8, tableTop: 139, headH: 22, rowH: 16.2 };
  drawHeader(c, doc, data, v);
  const bottom = drawTable(c, doc, data.items.slice(0, HALF_MAX_ROWS), 1, HALF_MAX_ROWS, v);
  drawTotal(c, doc, bottom, t.sum, 16, 9);
  // debt block: 2 x 2
  const y = bottom + 16 + 9;
  const cells = [
    ["Պարտքի նախկին մնացորդ՝", data.previousDebtAmd ?? null, 21.6, 289],
    ["Վճարում՝", data.paymentAmd ?? null, 306, 589.6],
    ["Պատվեր՝", t.orderTotal, 21.6, 289],
    ["Պարտքի ներկա մնացորդ՝", t.current, 306, 589.6],
  ];
  cells.forEach(([label, value, x1, x2], i) => {
    const ry = y + Math.floor(i / 2) * 15;
    c.text(label, x1 + 2, ry, { bold: true, size: 8.5 });
    const lx = x1 + 4 + c.textW(label, { bold: true, size: 8.5 });
    if (value !== null && value !== undefined) c.right(amd(value), x2 - 2, ry, { bold: true, size: 8.5 });
    else c.hline(ry + 10, lx, x2, "#555555", 0.5);
  });
  drawSignatures(c, data, y + 30 + 16, 8.5);
  doc.restore();
}

function drawCutLine(doc, y) {
  doc.save().moveTo(20, y).lineTo(A4.w - 20, y).dash(4, { space: 3 }).lineWidth(0.5).strokeColor("#9A9A9A").stroke().undash().restore();
}

// orders: [{ variant: "full" | "half" | undefined (= suggestVariant), order, items, customer, rep, previousDebtAmd, paymentAmd }]
// Half blanks are packed two to a sheet (a lone one takes the top half); full ones follow.
export function buildOrderBlanksPdf(orders) {
  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true, info: { Title: "Order blanks", Author: "KAD Motors" } });
  doc.registerFont("R", path.join(ASSET_DIR, "fonts", "DejaVuSans.ttf"));
  doc.registerFont("B", path.join(ASSET_DIR, "fonts", "DejaVuSans-Bold.ttf"));
  const chunks = [];
  doc.on("data", (x) => chunks.push(x));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const withVariant = orders.map((o) => ({ ...o, variant: o.variant ?? suggestVariant(o.items) }));
  const halves = withVariant.filter((o) => o.variant === "half" && o.items.length <= HALF_MAX_ROWS);
  const fulls = withVariant.filter((o) => !(o.variant === "half" && o.items.length <= HALF_MAX_ROWS));
  let drawn = false;
  for (let i = 0; i < halves.length; i += 2) {
    if (drawn) doc.addPage({ size: "A4", margin: 0 });
    drawn = true;
    const slotH = A4.h / 2;
    drawHalf(doc, halves[i], 0, slotH);
    if (halves[i + 1]) drawHalf(doc, halves[i + 1], slotH, slotH);
    drawCutLine(doc, slotH);
  }
  for (const f of fulls) {
    drawFull(doc, f, drawn);
    drawn = true;
  }
  if (!drawn) doc.text(" ");
  doc.end();
  return done;
}

export function buildOrderBlankPdf(data) {
  return buildOrderBlanksPdf([data]);
}
