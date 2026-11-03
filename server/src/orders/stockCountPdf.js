// The stock count's day report as a PDF (owner, 2026-11-03): who counted, when, every product with the Excel quantity, the counted quantity
// and the difference, the signature the warehouse manager drew, and -- when he added one -- the photo of the paper count. Armenian first
// (DejaVu fonts). Kept as a file for the accountants and the bosses (routes/stockCount.js GET /day/:day/pdf).
import PDFDocument from "pdfkit";
import fs from "node:fs";
import path from "node:path";
import { ASSETS_DIR } from "../shared/paths.js";
import { COMPANY_NAME } from "./orderBlankPdf.js";

const INK = "#10224a";
const LINE = "#cfd4de";
const RED = "#b3261e";
const M = 36; // page margin
const dmy = (day) => String(day).split("-").reverse().join(".");
const when = (ts) => (ts ? new Date(ts).toLocaleString("en-GB", { timeZone: "Asia/Yerevan", dateStyle: "short", timeStyle: "short" }) : "");
const signed = (n) => (n > 0 ? `+${n}` : String(n));

/**
 * data: { day, counter (name), finishedAt, auto (closed automatically), planned, counted, left_over,
 *         items: [{ name, brand, size, expected_qty, counted_qty, note }], signaturePng (Buffer|null), signedAt, attachmentImage (Buffer|null),
 *         attachmentIsPdf }
 */
export function buildStockCountPdf(data) {
  const doc = new PDFDocument({ size: "A4", margin: M, bufferPages: true, info: { Title: `Stock count ${data.day}`, Author: "KAD Motors" } });
  doc.registerFont("R", path.join(ASSETS_DIR, "fonts", "DejaVuSans.ttf"));
  doc.registerFont("B", path.join(ASSETS_DIR, "fonts", "DejaVuSans-Bold.ttf"));
  const chunks = [];
  doc.on("data", (x) => chunks.push(x));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const W = doc.page.width - 2 * M;
  const text = (s, x, y, o = {}) => doc.font(o.bold ? "B" : "R").fontSize(o.size ?? 9.5).fillColor(o.color ?? INK).text(String(s ?? ""), x, y, { lineBreak: false, width: o.width, align: o.align });
  const hline = (y) => doc.save().moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(LINE).stroke().restore();

  text(COMPANY_NAME ?? "KAD Motors", M, M, { bold: true, size: 11 });
  text("ԳՈՒՅՔԱԳՐՈՒՄ", M, M + 22, { bold: true, size: 15 });
  text(`${dmy(data.day)}թ.`, M, M + 44, { size: 10 });
  let y = M + 70;
  text(`Հաշվել է՝ ${data.counter || "—"}`, M, y);
  text(`Ավարտվել է՝ ${when(data.finishedAt)}${data.auto ? " (ավտոմատ, ստորագրված չէ)" : ""}`, M + W / 2, y);
  y += 16;
  text(`Ըստ պլանի՝ ${data.planned}   Հաշվվել է՝ ${data.counted}   Մնաց հաջորդ օրվան՝ ${data.left_over}`, M, y);
  const diffs = data.items.filter((i) => Number(i.counted_qty) !== Number(i.expected_qty ?? 0)).length;
  text(diffs ? `Տարբերություններ՝ ${diffs}` : "Տարբերություններ չկան", M + W / 2, y, { bold: true, color: diffs ? RED : INK });
  y += 24;

  // table: product | size | Excel | counted | difference
  const cols = [M, M + W * 0.5, M + W * 0.62, M + W * 0.74, M + W * 0.87, M + W];
  const head = (yy) => {
    doc.save().rect(M, yy, W, 20).fill("#e9ebf0").restore();
    ["ԱՊՐԱՆՔ", "ՉԱՓ", "EXCEL", "ՀԱՇՎՎԱԾ", "ՏԱՐԲԵՐ."].forEach((h, i) => text(h, cols[i] + 4, yy + 6, { bold: true, size: 7.5, width: cols[i + 1] - cols[i] - 8, align: i >= 2 ? "right" : "left" }));
    return yy + 20;
  };
  y = head(y);
  for (const it of data.items) {
    if (y > doc.page.height - 150) {
      doc.addPage();
      y = head(M);
    }
    const diff = Number(it.counted_qty) - Number(it.expected_qty ?? 0);
    const label = `${it.brand ? `${it.brand} · ` : ""}${it.name}`;
    text(label.length > 52 ? `${label.slice(0, 51)}…` : label, cols[0] + 4, y + 5, { size: 8.5, width: cols[1] - cols[0] - 8 });
    text(it.size ?? "", cols[1] + 4, y + 5, { size: 8.5, width: cols[2] - cols[1] - 8 });
    text(String(it.expected_qty ?? 0), cols[2] + 4, y + 5, { size: 8.5, width: cols[3] - cols[2] - 8, align: "right" });
    text(String(it.counted_qty), cols[3] + 4, y + 5, { size: 8.5, width: cols[4] - cols[3] - 8, align: "right", bold: true });
    text(diff ? signed(diff) : "—", cols[4] + 4, y + 5, { size: 8.5, width: cols[5] - cols[4] - 8, align: "right", bold: diff !== 0, color: diff ? RED : INK });
    if (it.note) {
      text(`  ${it.note}`.slice(0, 110), cols[0] + 4, y + 17, { size: 7, color: "#555555", width: W - 8 });
      y += 12;
    }
    y += 20;
    hline(y);
  }

  // signature block (never split from its heading)
  if (y > doc.page.height - 150) {
    doc.addPage();
    y = M;
  }
  y += 22;
  text("Ստորագրություն՝", M, y, { bold: true });
  if (data.signaturePng) {
    try {
      doc.image(data.signaturePng, M, y + 14, { fit: [180, 70] });
    } catch {
      text("(ստորագրությունը չի կարդացվում)", M, y + 20, { size: 8, color: RED });
    }
    text(`${data.counter || ""} · ${when(data.signedAt)}`, M, y + 90, { size: 8.5 });
  } else {
    text("Ստորագրված չէ (օրը փակվել է ավտոմատ)", M, y + 20, { size: 8.5, color: RED });
  }

  // the optional photo of the paper count on its own page; a PDF attachment stays a file of its own
  if (data.attachmentImage) {
    doc.addPage();
    text("Թղթային հաշվարկի լուսանկար", M, M, { bold: true });
    try {
      doc.image(data.attachmentImage, M, M + 20, { fit: [W, doc.page.height - 2 * M - 30], align: "center" });
    } catch {
      text("(նկարը չի կարդացվում)", M, M + 24, { size: 8, color: RED });
    }
  } else if (data.attachmentIsPdf) {
    text("Կից PDF ֆայլը պահվում է առանձին։", M, y + 110, { size: 8.5, color: "#555555" });
  }

  const range = doc.bufferedPageRange();
  if (range.count > 1) {
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      text(`Էջ ${i + 1}/${range.count}`, M, doc.page.height - 26, { size: 8, width: W, align: "right" });
    }
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
