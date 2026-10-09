// Print-ready "Delivery-acceptance act" (ՀԱՆՁՆՄԱՆ-ԸՆԴՈՒՆՄԱՆ ԱԿՏ) for one order,
// laid out like the company's printed order blank (Castrol_Order_Blank): four
// brand logos, company + manager contact lines, order number / date /
// customer / code, a numbered table (name, liters, qty, price, sum), TOTAL,
// the debt block (previous balance, order, payment, current balance) and the
// two signature lines. The layout below is drawn in the blank's own units
// (US-letter points, 612 x 792) and scaled to A4.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
const logo = (name) => fs.readFileSync(path.join(ASSET_DIR, "logos", `ob-${name}.png`));

export const COMPANY_NAME = "Քալանթարյան Ֆեմիլի ՓԲԸ";

const A4 = { w: 595.28, h: 841.89 };
const K = A4.w / 612; // uniform scale from the blank's letter-size units to A4
const INK = "#111111";
const LINE = "#8A8A8A";
const SHADE = "#F1F1F1";
const MIN_ROWS = 15;
// Column edges (blank units): No | name | liters | qty | price | sum
const COLS = [21.6, 52.8, 326, 377.6, 435, 497.6, 589.6];

function amd(n) {
  if (n === null || n === undefined || n === "") return "";
  return Math.round(Number(n)).toLocaleString("en-US");
}

function fit(doc, text, width, size) {
  doc.fontSize(size);
  let s = String(text ?? "");
  if (doc.widthOfString(s) <= width) return s;
  while (s.length > 1 && doc.widthOfString(`${s}…`) > width) s = s.slice(0, -1);
  return `${s}…`;
}

// order: { order_code, created_at (Date|string), total_amd }
// items: [{ product_name, brand, size_l, quantity, unit_price_amd, line_total_amd }]
// customer: { name, erp_customer_id }; rep: { name, phones: [string] }
// previousDebtAmd: customer's balance before this order (null = leave blank)
// paymentAmd: amount collected with this order (null = blank line to hand-write)
export function buildOrderBlankPdf({ order, items, customer, rep, previousDebtAmd = null, paymentAmd = null }) {
  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true, info: { Title: `Order ${order.order_code ?? ""}`, Author: "KAD Motors" } });
  doc.registerFont("R", path.join(ASSET_DIR, "fonts", "DejaVuSans.ttf"));
  doc.registerFont("B", path.join(ASSET_DIR, "fonts", "DejaVuSans-Bold.ttf"));

  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const rowsPerPage = 22;
  const pages = [];
  for (let i = 0; i < items.length; i += rowsPerPage) pages.push(items.slice(i, i + rowsPerPage));
  if (!pages.length) pages.push([]);

  const d = new Date(order.created_at ?? Date.now());
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const total = items.reduce((s, it) => s + Number(it.line_total_amd ?? Number(it.quantity) * Number(it.unit_price_amd)), 0);
  const orderTotal = order.total_amd != null ? Number(order.total_amd) : total;
  const currentDebt = previousDebtAmd !== null && paymentAmd !== null ? Number(previousDebtAmd) + orderTotal - Number(paymentAmd) : null;

  pages.forEach((chunk, pageIndex) => {
    if (pageIndex > 0) doc.addPage({ size: "A4", margin: 0 });
    const last = pageIndex === pages.length - 1;
    doc.save();
    doc.scale(K);
    const hline = (y, x1 = 21.6, x2 = 589.6, color = LINE, w = 0.6) => doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(w).strokeColor(color).stroke().restore();
    const text = (s, x, y, o = {}) => doc.font(o.bold ? "B" : "R").fontSize(o.size ?? 10).fillColor(INK).text(String(s ?? ""), x, y, { lineBreak: false, ...o.opts });
    const textW = (s, o = {}) => doc.font(o.bold ? "B" : "R").fontSize(o.size ?? 10).widthOfString(String(s ?? ""));
    const right = (s, xr, y, o = {}) => text(s, xr - textW(s, o), y, o);
    const center = (s, x1, x2, y, o = {}) => text(s, x1 + (x2 - x1 - textW(s, o)) / 2, y, o);
    const field = (label, value, x, y, lineEnd) => {
      text(label, x, y, { size: 10 });
      const lx = x + textW(label) + 4;
      if (value) text(value, lx + 2, y, { bold: true, size: 10 });
      else hline(y + 11, lx, lineEnd, "#555555", 0.5);
      if (value) hline(y + 11, lx, lineEnd, "#999999", 0.4);
    };

    // ---- logos -----------------------------------------------------------------
    doc.image(logo("aral"), 33.75, 8.5, { width: 64.5, height: 64.5 });
    doc.image(logo("castrol"), 112.65, 8.25, { width: 182, height: 48.6 });
    doc.image(logo("lotos"), 310.5, 45.8, { width: 127.5, height: 31.9 });
    doc.image(logo("royal"), 452.25, 18.7, { width: 131.2, height: 34.2 });

    // ---- company / manager block ---------------------------------------------------
    hline(81.5);
    text(COMPANY_NAME, 21.6, 85, { bold: false, size: 10 });
    text(`Մենեջեր՝ ${rep?.name ?? ""}`, 21.6, 98, { size: 10 });
    const phones = (rep?.phones ?? []).filter(Boolean);
    text("Հեռ՝", 413, 85, { size: 10 });
    phones.slice(0, 2).forEach((p, i) => text(p, 448, 85 + i * 13, { size: 10 }));
    hline(114);

    // ---- order number / date / customer / code ---------------------------------------
    field("Պատվերի No՝", order.order_code ?? "", 21.6, 138, 170);
    text("Ամսաթիվ՝", 416, 138, { size: 10 });
    center(dd, 468, 495, 138, { bold: true });
    hline(149, 466, 497, "#555555", 0.5);
    text("/", 499, 138);
    center(mm, 505, 532, 138, { bold: true });
    hline(149, 504, 534, "#555555", 0.5);
    text(`/ ${d.getFullYear()}թ.`, 537, 138, { size: 10 });
    field("Գործընկերոջ անվանում՝", fit(doc, customer?.name ?? "", 250, 10), 21.6, 170, 400);
    field("Կոդ՝", customer?.erp_customer_id ?? "", 500, 170, 589.6);

    // ---- title --------------------------------------------------------------------------
    center("ՀԱՆՁՆՄԱՆ-ԸՆԴՈՒՆՄԱՆ ԱԿՏ", 21.6, 589.6, 213, { bold: true, size: 11 });
    const tw = textW("ՀԱՆՁՆՄԱՆ-ԸՆԴՈՒՆՄԱՆ ԱԿՏ", { bold: true, size: 11 });
    hline(226, (611.2 - tw) / 2, (611.2 + tw) / 2, INK, 0.8);

    // ---- table ------------------------------------------------------------------------------
    const top = 249;
    const headH = 28;
    const rowCount = Math.max(MIN_ROWS, chunk.length);
    const rowH = Math.min(20.7, (last ? 612 - top - headH - 22 : 700 - top - headH) / rowCount);
    const tableBottom = top + headH + rowCount * rowH;
    const grid = (y1, y2) => COLS.forEach((x) => doc.save().moveTo(x, y1).lineTo(x, y2).lineWidth(0.6).strokeColor(LINE).stroke().restore());
    doc.save().rect(COLS[0], top, COLS[6] - COLS[0], headH).fill("#E9E9E9").restore();
    const heads = ["Հ/Հ", "ՄԱՏԱԿԱՐԱՐՎԱԾ ԱՊՐԱՆՔԻ ԱՆՎԱՆՈՒՄ", "Չ/Մ\n(ԼԻՏՐ)", "ՔԱՆԱԿ", "ԳԻՆ", "ԳՈՒՄԱՐ"];
    heads.forEach((h, i) => {
      const lines = h.split("\n");
      const y0 = top + (headH - lines.length * 10) / 2 + 0.5;
      lines.forEach((l, li) => center(l, COLS[i], COLS[i + 1], y0 + li * 10, { bold: true, size: 8.5 }));
    });
    for (let r = 0; r < rowCount; r++) {
      const y = top + headH + r * rowH;
      if (r % 2 === 0) doc.save().rect(COLS[0], y, COLS[6] - COLS[0], rowH).fill(SHADE).restore();
      const it = chunk[r];
      const n = pageIndex * rowsPerPage + r + 1;
      const ty = y + (rowH - 9) / 2;
      text(String(n), COLS[0] + 3, ty, { size: 9 });
      if (it) {
        const name = [it.brand, it.product_name].filter(Boolean).join(" ").replace(/\s+/g, " ");
        text(fit(doc, name, COLS[2] - COLS[1] - 8, 9), COLS[1] + 4, ty, { size: 9 });
        const liters = it.size_l != null && it.size_l !== "" ? String(it.size_l).replace(/L$/i, "") : "";
        center(liters, COLS[2], COLS[3], ty, { size: 9 });
        center(String(Number(it.quantity)), COLS[3], COLS[4], ty, { size: 9 });
        right(amd(it.unit_price_amd), COLS[5] - 5, ty, { size: 9 });
        right(amd(it.line_total_amd ?? Number(it.quantity) * Number(it.unit_price_amd)), COLS[6] - 5, ty, { size: 9 });
      }
    }
    // outer box + inner lines
    doc.save().rect(COLS[0], top, COLS[6] - COLS[0], tableBottom - top).lineWidth(0.8).strokeColor("#555555").stroke().restore();
    hline(top + headH, COLS[0], COLS[6], "#555555", 0.8);
    for (let r = 1; r < rowCount; r++) hline(top + headH + r * rowH, COLS[0], COLS[6], "#C4C4C4", 0.4);
    grid(top, tableBottom);

    let y = tableBottom;
    if (last) {
      // ---- total -----------------------------------------------------------------------------
      const totH = 22;
      doc.save().rect(COLS[0], y, COLS[6] - COLS[0], totH).lineWidth(0.8).strokeColor("#555555").stroke().restore();
      text("ԸՆԴԱՄԵՆԸ՝", COLS[0] + 3, y + 6, { bold: true, size: 10 });
      right(amd(total), COLS[6] - 5, y + 6, { bold: true, size: 10 });
      y += totH + 22;

      // ---- debt block -----------------------------------------------------------------------------
      const rows = [
        ["Պարտքի նախկին մնացորդ՝", previousDebtAmd],
        ["Պատվեր՝", orderTotal],
        ["Վճարում՝", paymentAmd],
        ["Պարտքի ներկա մնացորդ՝", currentDebt],
      ];
      rows.forEach(([label, value], i) => {
        const ry = y + i * 21;
        if (i % 2 === 1 || i === 3) doc.save().rect(21.6, ry - 3, 568, 21).fill(SHADE).restore();
        text(label, 21.6 + 3, ry + 1, { bold: true, size: 10 });
        if (value !== null && value !== undefined) right(amd(value), 580, ry + 1, { bold: true, size: 10 });
        else hline(ry + 12, 215, 589, "#555555", 0.5);
      });
      y += rows.length * 21 + 38;

      // ---- signatures -------------------------------------------------------------------------------
      field("Հանձնեց՝", rep?.name ?? "", 21.6, y, 345);
      field("Ընդունեց՝", "", 379, y, 589.6);
      center("ստորագրություն", 21.6 + textW("Հանձնեց՝") + 4, 345, y + 14, { size: 7.5 });
      center("ստորագրություն", 379 + textW("Ընդունեց՝") + 4, 589.6, y + 14, { size: 7.5 });
    } else {
      text("Շարունակությունը հաջորդ էջում…", 21.6, tableBottom + 8, { size: 9 });
    }
    doc.restore();
  });

  doc.end();
  return done;
}
