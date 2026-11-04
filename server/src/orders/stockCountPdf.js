// The stock count's day report as a PDF (owner, 2026-11-03): who counted, when, every product with the app's stock, the counted quantity
// and the difference, the signature the warehouse manager drew, and -- when he added one -- the photo of the paper count. Armenian first
// (DejaVu fonts). Kept as a file for the accountants and the bosses (routes/stockCount.js GET /day/:day/pdf).
// Layout 2 (owner, 2026-11-04): numbered rows in the Products order, the columns "Ծրագրով մնացորդ / Փաստացի առկա / Տարբերություն", the
// counter's full name (and position), and the signature block -- name, signature, date -- at the bottom of EVERY page (signed once,
// shown on all pages), with "Էջ 2/3" when there is more than one page.
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { ASSETS_DIR } from "../shared/paths.js";
import { COMPANY_NAME } from "./orderBlankPdf.js";
import { normalizeUnitLabel } from "../../../client/public/js/productSort.js";

/** Bumped when the layout changes: a saved PDF of an older layout is made again when it is opened (routes/stockCount.js). */
export const PDF_LAYOUT = "L2";

const INK = "#10224a";
const LINE = "#cfd4de";
const MUTED = "#5b6475";
const RED = "#b3261e";
const M = 36; // page margin
const FOOT = 96; // the signature block at the bottom of every page
const dmy = (day) => String(day).split("-").reverse().join(".");
const when = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { timeZone: "Asia/Yerevan", dateStyle: "short", timeStyle: "short" }).replace(/\//g, ".") : "");
const dateOf = (ts) => (ts ? new Date(ts).toLocaleDateString("en-GB", { timeZone: "Asia/Yerevan" }).replace(/\//g, ".") : "");
const signed = (n) => (n > 0 ? `+${n}` : String(n));

/**
 * data: { day, counter (full name), counterPosition, finishedAt, auto (closed automatically), planned, counted, left_over,
 *         items: [{ name, brand, size, expected_qty, counted_qty, note }] (already in the Products order), signaturePng (Buffer|null),
 *         signedAt, attachmentImage (Buffer|null), attachmentIsPdf }
 */
export function buildStockCountPdf(data) {
  const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true, info: { Title: `Stock count ${data.day}`, Author: COMPANY_NAME } });
  doc.registerFont("R", path.join(ASSETS_DIR, "fonts", "DejaVuSans.ttf"));
  doc.registerFont("B", path.join(ASSETS_DIR, "fonts", "DejaVuSans-Bold.ttf"));
  const chunks = [];
  doc.on("data", (x) => chunks.push(x));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width - 2 * M;
  const H = doc.page.height;
  const BOTTOM = H - M - FOOT - 10; // the table and the photo stop here: the signature block below never overlaps them
  const text = (s, x, y, o = {}) => doc.font(o.bold ? "B" : "R").fontSize(o.size ?? 9.5).fillColor(o.color ?? INK).text(String(s ?? ""), x, y, { lineBreak: false, width: o.width, align: o.align });
  const hline = (y, x1 = M, x2 = M + W, color = LINE) => doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(0.5).strokeColor(color).stroke().restore();

  // --- the title block (first page)
  text(COMPANY_NAME, M, M, { bold: true, size: 11 });
  text("ԳՈՒՅՔԱԳՐՈՒՄ", M, M + 22, { bold: true, size: 15 });
  text(`${dmy(data.day)}թ.`, M, M + 44, { size: 10 });
  let y = M + 70;
  const who = data.counter ? `${data.counter}${data.counterPosition ? `, ${data.counterPosition}` : ""}` : "—";
  text(`Հաշվել է՝ ${who}`, M, y, { width: W * 0.6 });
  text(`Ավարտվել է՝ ${when(data.finishedAt)}${data.auto ? " (ավտոմատ)" : ""}`, M + W * 0.6, y, { width: W * 0.4, align: "right" });
  y += 16;
  // "left for the next day" only when something was left (owner, 2026-11-04)
  text(`Ըստ պլանի՝ ${data.planned}   Հաշվվել է՝ ${data.counted}${data.left_over > 0 ? `   Մնաց հաջորդ օրվան՝ ${data.left_over}` : ""}`, M, y, { width: W * 0.65 });
  const diffs = data.items.filter((i) => Number(i.counted_qty) !== Number(i.expected_qty ?? 0)).length;
  text(diffs ? `Տարբերություններ՝ ${diffs}` : "Տարբերություններ չկան", M + W * 0.65, y, { bold: true, color: diffs ? RED : INK, width: W * 0.35, align: "right" });
  y += 24;

  // --- the table: № | products | size | in the app | counted | difference
  const widths = [0.06, 0.44, 0.1, 0.14, 0.13, 0.13];
  const cols = [M];
  for (const w of widths) cols.push(cols[cols.length - 1] + W * w);
  const heads = ["№", "Ապրանքներ", "Չափ", "Ծրագրով մնացորդ", "Փաստացի առկա", "Տարբերություն"];
  const HEAD_H = 26;
  const head = (yy) => {
    doc.save().rect(M, yy, W, HEAD_H).fill("#e9ebf0").restore();
    heads.forEach((h, i) => {
      const width = cols[i + 1] - cols[i] - 8;
      doc.font("B").fontSize(7.5);
      const hh = doc.heightOfString(h, { width });
      doc.fillColor(INK).text(h, cols[i] + 4, yy + (HEAD_H - hh) / 2, { width, align: i >= 3 ? "right" : i === 0 ? "center" : "left" });
    });
    return yy + HEAD_H;
  };
  y = head(y);
  data.items.forEach((it, n) => {
    const rowH = it.note ? 32 : 20;
    if (y + rowH > BOTTOM) {
      doc.addPage();
      text(`${COMPANY_NAME} · Գույքագրում ${dmy(data.day)}թ.`, M, M, { size: 8.5, color: MUTED });
      y = head(M + 16);
    }
    const diff = Number(it.counted_qty) - Number(it.expected_qty ?? 0);
    const label = `${it.brand ? `${it.brand} · ` : ""}${it.name}`;
    const cell = (i) => ({ size: 8.5, width: cols[i + 1] - cols[i] - 8 });
    text(String(n + 1), cols[0] + 4, y + 5, { ...cell(0), align: "center", color: MUTED });
    text(label.length > 48 ? `${label.slice(0, 47)}…` : label, cols[1] + 4, y + 5, cell(1));
    text(normalizeUnitLabel(it.size), cols[2] + 4, y + 5, cell(2));
    text(String(it.expected_qty ?? 0), cols[3] + 4, y + 5, { ...cell(3), align: "right" });
    text(String(it.counted_qty), cols[4] + 4, y + 5, { ...cell(4), align: "right", bold: true });
    text(diff ? signed(diff) : "—", cols[5] + 4, y + 5, { ...cell(5), align: "right", bold: diff !== 0, color: diff ? RED : INK });
    if (it.note) text(it.note.length > 110 ? `${it.note.slice(0, 109)}…` : it.note, cols[1] + 4, y + 18, { size: 7, color: MUTED, width: W - (cols[1] - M) - 8 });
    y += rowH;
    hline(y);
  });
  if (data.attachmentIsPdf && y + 20 <= BOTTOM) text("Կից PDF ֆայլը (թղթային հաշվարկը) պահվում է առանձին։", M, y + 10, { size: 8.5, color: MUTED });

  // --- the optional photo of the paper count on its own page (above the signature block, like every page)
  if (data.attachmentImage) {
    doc.addPage();
    text("Թղթային հաշվարկի լուսանկար", M, M, { bold: true });
    try {
      doc.image(data.attachmentImage, M, M + 20, { fit: [W, BOTTOM - M - 20], align: "center" });
    } catch {
      text("(նկարը չի կարդացվում)", M, M + 24, { size: 8, color: RED });
    }
  }

  // --- the signature block and the page number on every page: name | signature | date, each over a line with its caption
  let signature = null;
  if (data.signaturePng) {
    try {
      signature = doc.openImage(data.signaturePng); // embedded once, placed on every page
    } catch {
      signature = "broken";
    }
  }
  const range = doc.bufferedPageRange();
  const c1 = [M, M + W * 0.4]; // name
  const c2 = [M + W * 0.45, M + W * 0.75]; // signature
  const c3 = [M + W * 0.8, M + W]; // date
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const top = H - M - FOOT;
    const base = top + 64; // the signature line
    hline(top, M, M + W);
    text("Գույքագրումը կատարեց՝", M, top + 8, { bold: true, size: 9 });
    // name (and position)
    if (data.counterPosition && data.counter) text(data.counterPosition, c1[0], base - 26, { size: 8, color: MUTED, width: c1[1] - c1[0] });
    text(data.counter || "—", c1[0], base - 13, { size: 10, width: c1[1] - c1[0] });
    // signature
    if (signature && signature !== "broken") {
      doc.image(signature, c2[0], base - 46, { fit: [c2[1] - c2[0], 44], align: "center", valign: "bottom" });
    } else if (signature === "broken") {
      text("(ստորագրությունը չի կարդացվում)", c2[0], base - 13, { size: 7.5, color: RED, width: c2[1] - c2[0], align: "center" });
    } else {
      text("Ստորագրված չէ (օրը փակվել է ավտոմատ)", c2[0], base - 13, { size: 7.5, color: RED, width: c2[1] - c2[0], align: "center" });
    }
    // date
    text(`${data.signedAt ? dateOf(data.signedAt) : dmy(data.day)}թ.`, c3[0], base - 13, { size: 10, width: c3[1] - c3[0], align: "center" });
    for (const [a, b] of [c1, c2, c3]) hline(base, a, b, INK);
    text("(անուն, ազգանուն)", c1[0], base + 4, { size: 7, color: MUTED, width: c1[1] - c1[0] });
    text("(ստորագրություն)", c2[0], base + 4, { size: 7, color: MUTED, width: c2[1] - c2[0], align: "center" });
    text("(ամսաթիվ)", c3[0], base + 4, { size: 7, color: MUTED, width: c3[1] - c3[0], align: "center" });
    if (range.count > 1) text(`Էջ ${i + 1}/${range.count}`, M, H - M + 8, { size: 8, width: W, align: "right", color: MUTED });
  }
  doc.end();
  return done;
}

export const readIfExists = async (file) => {
  try {
    return file ? await fs.promises.readFile(file) : null;
  } catch {
    return null;
  }
};
