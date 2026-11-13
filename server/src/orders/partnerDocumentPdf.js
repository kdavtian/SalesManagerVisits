// The PDF of a document for signature (e-signature engine, owner 2026-11-13): the same fonts as the order blanks (DejaVu covers Armenian),
// title, number and version, the customer, the frozen content (summary, lines, totals, the legal text), both signatures with names, roles
// and times, "signed electronically" and the fingerprint on every page. Built twice: when the document is sent (KAD Motors' side signed,
// the customer's line empty) and when the customer signs (both signatures).
import path from "node:path";
import PDFDocument from "pdfkit";
import { ASSETS_DIR } from "../shared/paths.js";
import { COMPANY_NAME, cleanCustomerName, yerevanDate, yerevanDateTime } from "./orderBlankPdf.js";

const A4 = { w: 595.28, h: 841.89 };
const M = 42; // page margin
const W = A4.w - 2 * M;
const INK = "#111111";
const MUTED = "#555555";
const LINE = "#9A9A9A";
const SHADE = "#F1F1F1";
const FOOT = 34; // room kept for the fingerprint line at the bottom of every page

const amd = (n) => (n === null || n === undefined || n === "" ? "" : `${Math.round(Number(n)).toLocaleString("en-US")} դր`);
const qtyText = (n) => (n === null || n === undefined || n === "" ? "" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 3 }));

export const ISSUE_LABELS = { short: "պակաս", damaged: "վնասված", wrong: "սխալ ապրանք", unknown: "անհայտ տող", amount: "սխալ գումար" };

/**
 * doc: { number, version, title, kind, content, fingerprint, sent_at, kad_signer, customer_signer, remarks }
 * customer: { name, erp_customer_id }
 * images: { kad: PNG Buffer | null, customer: PNG Buffer | null }
 */
export function buildPartnerDocumentPdf(doc, customer, images = {}) {
  const pdf = new PDFDocument({ size: "A4", margin: 0, bufferPages: true, info: { Title: `${doc.title} ${doc.number}`, Author: "KAD Motors" } });
  pdf.registerFont("R", path.join(ASSETS_DIR, "fonts", "DejaVuSans.ttf"));
  pdf.registerFont("B", path.join(ASSETS_DIR, "fonts", "DejaVuSans-Bold.ttf"));
  const chunks = [];
  pdf.on("data", (x) => chunks.push(x));
  const done = new Promise((resolve) => pdf.on("end", () => resolve(Buffer.concat(chunks))));

  let y = M;
  const font = (bold, size) => pdf.font(bold ? "B" : "R").fontSize(size).fillColor(INK);
  const hline = (yy, x1 = M, x2 = M + W, color = LINE, w = 0.6) => pdf.save().moveTo(x1, yy).lineTo(x2, yy).lineWidth(w).strokeColor(color).stroke().restore();
  const room = (h) => {
    if (y + h <= A4.h - M - FOOT) return false;
    pdf.addPage({ size: "A4", margin: 0 });
    y = M;
    return true;
  };
  const para = (text, { bold = false, size = 10, color = INK, gap = 4, align = "left", x = M, width = W } = {}) => {
    font(bold, size).fillColor(color);
    const h = pdf.heightOfString(String(text), { width, align, lineGap: 1.5 });
    room(h);
    pdf.text(String(text), x, y, { width, align, lineGap: 1.5 });
    y += h + gap;
  };

  // ---- header: the company on the left, the number on the right
  font(true, 11).text(COMPANY_NAME, M, y, { lineBreak: false });
  font(false, 9).fillColor(MUTED).text("KAD Motors", M, y + 14, { lineBreak: false });
  const no = `№ ${doc.number}`;
  font(true, 11);
  pdf.text(no, M + W - pdf.widthOfString(no), y, { lineBreak: false });
  const ver = `Տարբերակ ${doc.version} · ${yerevanDate(doc.sent_at ?? Date.now())}`;
  font(false, 9).fillColor(MUTED);
  pdf.text(ver, M + W - pdf.widthOfString(ver), y + 14, { lineBreak: false });
  y += 34;
  hline(y);
  y += 14;
  para(doc.title, { bold: true, size: 15, align: "center", gap: 10 });

  // ---- customer + summary as label / value rows
  const rows = [["Հաճախորդ", cleanCustomerName(customer?.name)], ...(customer?.erp_customer_id ? [["Կոդ", String(customer.erp_customer_id)]] : [])];
  for (const s of doc.content?.summary ?? []) rows.push([s.label, s.value]);
  for (const [label, value] of rows) {
    const lw = 150;
    const labelH = font(false, 10).heightOfString(String(label ?? ""), { width: lw - 8 });
    const h = Math.max(labelH, font(true, 10).heightOfString(String(value ?? ""), { width: W - lw }));
    room(h + 6);
    font(false, 10).fillColor(MUTED).text(String(label ?? ""), M, y, { width: lw - 8 });
    font(true, 10).text(String(value ?? ""), M + lw, y, { width: W - lw });
    y += h + 5;
  }
  y += 6;

  // ---- lines
  const lines = doc.content?.lines ?? [];
  if (lines.length) {
    // No | name (+ note) | qty | unit | price | amount
    const cols = [M, M + 26, M + 270, M + 320, M + 360, M + 435, M + W];
    const head = () => {
      pdf.save().rect(M, y, W, 20).fill(SHADE).restore();
      font(true, 8.5);
      ["№", "Անվանում", "Քանակ", "Միավոր", "Գին", "Գումար"].forEach((h, i) => {
        const right = i >= 2;
        const w = pdf.widthOfString(h);
        pdf.text(h, right ? cols[i + 1] - 5 - w : cols[i] + 4, y + 6, { lineBreak: false });
      });
      y += 20;
    };
    room(40);
    head();
    lines.forEach((ln, i) => {
      font(false, 9);
      const nameH = pdf.heightOfString(String(ln.name ?? ""), { width: cols[2] - cols[1] - 8 });
      const noteH = ln.note ? font(false, 7.5).heightOfString(String(ln.note), { width: cols[2] - cols[1] - 8 }) + 2 : 0;
      const h = Math.max(18, nameH + noteH + 8);
      if (room(h)) head();
      font(false, 9).text(String(i + 1), cols[0] + 4, y + 4, { lineBreak: false });
      pdf.text(String(ln.name ?? ""), cols[1] + 4, y + 4, { width: cols[2] - cols[1] - 8 });
      if (ln.note) font(false, 7.5).fillColor(MUTED).text(String(ln.note), cols[1] + 4, y + 4 + nameH + 2, { width: cols[2] - cols[1] - 8 });
      const cell = (s, ci) => {
        font(false, 9);
        const str = String(s ?? "");
        pdf.text(str, cols[ci + 1] - 5 - pdf.widthOfString(str), y + 4, { lineBreak: false });
      };
      cell(qtyText(ln.qty), 2);
      cell(ln.unit, 3);
      cell(amd(ln.price_amd), 4);
      cell(amd(ln.amount_amd), 5);
      y += h;
      hline(y, M, M + W, "#CCCCCC", 0.4);
    });
    y += 8;
  }

  // ---- totals, right-aligned
  for (const tot of doc.content?.totals ?? []) {
    room(16);
    font(true, 10);
    const value = amd(tot.amount_amd);
    const vw = pdf.widthOfString(value);
    pdf.text(value, M + W - vw, y, { lineBreak: false });
    font(false, 10);
    const label = String(tot.label ?? "");
    pdf.text(label, M + W - vw - 14 - pdf.widthOfString(label), y, { lineBreak: false });
    y += 16;
  }
  if (doc.content?.totals?.length) y += 6;

  // ---- the legal text the signer accepts
  if (doc.content?.text) {
    for (const p of String(doc.content.text).split(/\n+/)) if (p.trim()) para(p.trim(), { size: 9.5, gap: 5 });
    y += 4;
  }

  // ---- what the customer marked (signed with remarks)
  if (doc.remarks?.length) {
    para("Հաճախորդի նշումները", { bold: true, size: 10, gap: 3 });
    const byKey = new Map(lines.map((l) => [String(l.key), l]));
    for (const r of doc.remarks) {
      const name = byKey.get(String(r.key))?.name ?? r.key;
      para(`• ${name}: ${ISSUE_LABELS[r.issue] ?? r.issue}${r.qty != null ? ` (${qtyText(r.qty)})` : ""}${r.comment ? ` — ${r.comment}` : ""}`, { size: 9, gap: 2 });
    }
    y += 6;
  }

  // ---- the two signatures
  room(150);
  y += 6;
  const boxW = (W - 20) / 2;
  const side = (x, heading, signer, img) => {
    let yy = y;
    font(true, 10).text(heading, x, yy, { width: boxW });
    yy += 16;
    const nameLine = signer?.name ? `${signer.name}${signer.role ? `, ${signer.role}` : ""}` : "";
    font(false, 9.5).text(nameLine || " ", x, yy, { width: boxW });
    yy += 16;
    if (img) {
      try {
        pdf.image(img, x, yy, { fit: [boxW, 54], align: "left", valign: "bottom" });
      } catch {
        /* an unreadable image leaves the line empty */
      }
    }
    yy += 56;
    hline(yy, x, x + boxW, "#555555", 0.5);
    font(false, 7).fillColor(MUTED).text("ստորագրություն", x, yy + 3, { width: boxW, align: "center" });
    yy += 14;
    if (signer?.signed_at) font(false, 8).fillColor(INK).text(`Ստորագրվել է էլեկտրոնային եղանակով՝ ${yerevanDateTime(signer.signed_at)}`, x, yy, { width: boxW });
    return yy + 24;
  };
  const kadBottom = side(M, "KAD Motors", doc.kad_signer, images.kad);
  const custBottom = side(M + boxW + 20, cleanCustomerName(customer?.name) || "Հաճախորդ", doc.customer_signer, images.customer);
  y = Math.max(kadBottom, custBottom);
  if (doc.customer_signer?.signed_at) {
    para(
      `Ստորագրվել է էլեկտրոնային եղանակով KAD OS ծրագրում${doc.customer_signer.pin_verified ? "՝ անձնական PIN կոդով" : ""}։ Ստորագրված բովանդակության թվային դրոշմը (SHA-256) նշված է ստորև։`,
      { size: 8, color: MUTED, gap: 2 }
    );
  }

  // ---- the fingerprint and the page number at the foot of every page
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    hline(A4.h - M - 16, M, M + W, "#CCCCCC", 0.4);
    font(false, 6.5).fillColor(MUTED).text(`${doc.number} v${doc.version} · SHA-256: ${doc.fingerprint}`, M, A4.h - M - 10, { lineBreak: false });
    const pg = `${i - range.start + 1}/${range.count}`;
    pdf.text(pg, M + W - pdf.widthOfString(pg), A4.h - M - 10, { lineBreak: false });
  }
  pdf.end();
  return done;
}
