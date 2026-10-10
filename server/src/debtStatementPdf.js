// "Debt statement" (ՊԱՐՏՔԻ ԱՄՓՈՓԱԹԵՐԹ): one customer's unpaid invoices on a single A4 sheet the rep
// can send to the customer -- order, date, due date, amount, still unpaid and how many days late
// (or left). Oldest first, with the opening balance of the paper era on top. Armenian, amounts as
// `5,700 դր`. The invoice list comes from the FIFO allocation in debtAging.js.
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { formatPhone } from "./phoneFormat.js";
import { OFFICE_PHONE } from "./pricelistPdf.js";
import { COMPANY_NAME, cleanCustomerName } from "./orderBlankPdf.js";

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
const INK = "#111111";
const LINE = "#8A8A8A";
const SHADE = "#F1F1F1";
const RED = "#B3261E";
const AMBER = "#9A6700";
const X0 = 36;
const X1 = 559.28;
// No | order | date | due date | amount | unpaid | late/left
const COLS = [X0, 60, 164, 226, 302, 378, 450, X1];
const ROW_H = 20;
const FIRST_PAGE_ROWS = 24;
const NEXT_PAGE_ROWS = 34;

const amd = (n) => `${Math.round(Number(n) || 0).toLocaleString("en-US")} դր`;
const dmy = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

function addDays(iso, days) {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// "12 օր ուշացում" / "5 օր մնաց" / "Այսօր"
export function lateLabel(dueDays) {
  if (dueDays > 0) return `${dueDays} օր ուշացում`;
  if (dueDays === 0) return "Այսօր";
  return `${-dueDays} օր մնաց`;
}

// data: { today, termDays, customer: { name, erp_customer_id, legal_name, tin }, rep: { name, phone },
//         alloc: allocateFifo() result, debt_amd, synced_at }
export function buildDebtStatementPdf(data) {
  const doc = new PDFDocument({ size: "A4", margin: 0, bufferPages: true, info: { Title: "Debt statement", Author: "KAD Motors" } });
  doc.registerFont("R", path.join(ASSET_DIR, "fonts", "DejaVuSans.ttf"));
  doc.registerFont("B", path.join(ASSET_DIR, "fonts", "DejaVuSans-Bold.ttf"));
  const chunks = [];
  doc.on("data", (x) => chunks.push(x));
  const done = new Promise((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const text = (s, x, y, o = {}) => doc.font(o.bold ? "B" : "R").fontSize(o.size ?? 10).fillColor(o.color ?? INK).text(String(s ?? ""), x, y, { lineBreak: false });
  const width = (s, o = {}) => doc.font(o.bold ? "B" : "R").fontSize(o.size ?? 10).widthOfString(String(s ?? ""));
  const right = (s, xr, y, o = {}) => text(s, xr - width(s, o), y, o);
  const center = (s, x1, x2, y, o = {}) => text(s, x1 + (x2 - x1 - width(s, o)) / 2, y, o);
  const hline = (y, x1 = X0, x2 = X1, color = LINE, w = 0.6) => doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(w).strokeColor(color).stroke().restore();
  const fit = (s, maxW, o = {}) => {
    let t = String(s ?? "");
    if (width(t, o) <= maxW) return t;
    while (t.length > 1 && width(`${t}…`, o) > maxW) t = t.slice(0, -1);
    return `${t}…`;
  };

  // Rows, oldest first: the opening balance, then the unpaid invoices from the oldest to the newest.
  const rows = [];
  if (data.alloc.opening) {
    rows.push({ label: "Նախկին մնացորդ", date: null, due: addDays("2025-05-01", data.termDays), total: data.alloc.opening.unpaid, unpaid: data.alloc.opening.unpaid, days: data.alloc.opening.due_days });
  }
  for (const inv of [...data.alloc.invoices].reverse()) {
    rows.push({ label: String(inv.order_id), date: inv.date, due: addDays(inv.date, data.termDays), total: inv.total, unpaid: inv.unpaid, days: inv.due_days });
  }
  const pages = [rows.slice(0, FIRST_PAGE_ROWS)];
  for (let i = FIRST_PAGE_ROWS; i < rows.length; i += NEXT_PAGE_ROWS) pages.push(rows.slice(i, i + NEXT_PAGE_ROWS));

  const overdueTotal = data.alloc.overdue_amd;
  const unpaidTotal = rows.reduce((s, r) => s + r.unpaid, 0);

  function drawTableHead(y) {
    doc.save().rect(X0, y, X1 - X0, 24).fill("#E9E9E9").restore();
    ["Հ/Հ", "ՊԱՏՎԵՐ", "ԱՄՍԱԹԻՎ", "ՎՃԱՐՄԱՆ ԺԱՄԿԵՏ", "ԳՈՒՄԱՐ", "ՉՎՃԱՐՎԱԾ", "ՈՒՇԱՑՈՒՄ"].forEach((h, i) => center(h, COLS[i], COLS[i + 1], y + 8, { bold: true, size: 6.5 }));
    return y + 24;
  }

  let startNo = 1;
  pages.forEach((chunk, pi) => {
    if (pi > 0) doc.addPage({ size: "A4", margin: 0 });
    let y = 36;
    if (pi === 0) {
      text(COMPANY_NAME, X0, y, { bold: true, size: 11 });
      text(`Մենեջեր՝ ${data.rep?.name ?? ""}`, X0, y + 15, { size: 9 });
      const phones = [data.rep?.phone ? `Հեռ՝ ${formatPhone(data.rep.phone)}` : null, `Գրասենյակ՝ ${formatPhone(OFFICE_PHONE)}`].filter(Boolean);
      phones.forEach((p, i) => right(p, X1, y + i * 15, { size: 9 }));
      y += 44;
      hline(y);
      const title = "ՊԱՐՏՔԻ ԱՄՓՈՓԱԹԵՐԹ";
      center(title, X0, X1, y + 14, { bold: true, size: 13 });
      center(`${dmy(data.today)}թ.`, X0, X1, y + 34, { size: 9 });
      y += 60;
      const field = (label, value, x, yy, maxW) => {
        text(label, x, yy, { size: 9.5 });
        text(fit(value, maxW - width(label, { size: 9.5 }) - 6, { bold: true, size: 9.5 }), x + width(label, { size: 9.5 }) + 4, yy, { bold: true, size: 9.5 });
      };
      field("Գործընկեր՝", cleanCustomerName(data.customer.name), X0, y, 360);
      field("Կոդ՝", data.customer.erp_customer_id ?? "", 420, y, X1 - 420);
      if (data.customer.legal_name || data.customer.tin) {
        y += 16;
        field("Իրավ. անվանում՝", data.customer.legal_name ?? "", X0, y, 360);
        field("ՀՎՀՀ՝", data.customer.tin ?? "", 420, y, X1 - 420);
      }
      y += 16;
      field("Վճարման ժամկետ՝", `${data.termDays} օր`, X0, y, 360);
      y += 26;
    } else {
      text(`${cleanCustomerName(data.customer.name)} — պարտքի ամփոփաթերթ`, X0, y, { bold: true, size: 9.5 });
      y += 22;
    }
    const top = y;
    y = drawTableHead(y);
    chunk.forEach((r, i) => {
      if ((startNo + i) % 2 === 1) doc.save().rect(X0, y, X1 - X0, ROW_H).fill(SHADE).restore();
      const ty = y + 6;
      const late = r.days > 0 ? RED : r.days === 0 ? AMBER : INK;
      center(String(startNo + i), COLS[0], COLS[1], ty, { size: 8.5 });
      text(fit(r.label, COLS[2] - COLS[1] - 8, { size: 8.5 }), COLS[1] + 4, ty, { size: 8.5 });
      center(r.date ? dmy(r.date) : "—", COLS[2], COLS[3], ty, { size: 8.5 });
      center(dmy(r.due), COLS[3], COLS[4], ty, { size: 8.5 });
      right(amd(r.total), COLS[5] - 6, ty, { size: 8.5 });
      right(amd(r.unpaid), COLS[6] - 6, ty, { bold: true, size: 8.5 });
      center(lateLabel(r.days), COLS[6], COLS[7], ty, { size: 8, color: late, bold: r.days > 0 });
      y += ROW_H;
    });
    startNo += chunk.length;
    doc.save().rect(X0, top, X1 - X0, y - top).lineWidth(0.8).strokeColor("#555555").stroke().restore();
    COLS.slice(1, -1).forEach((x) => doc.save().moveTo(x, top).lineTo(x, y).lineWidth(0.5).strokeColor(LINE).stroke().restore());
    if (pi < pages.length - 1) {
      text("Շարունակությունը հաջորդ էջում…", X0, y + 8, { size: 8.5 });
      return;
    }
    y += 14;
    const total = (label, value, bold, color) => {
      doc.save().rect(X0, y - 3, X1 - X0, 22).fill(SHADE).restore();
      text(label, X0 + 6, y + 3, { bold: true, size: 10 });
      right(value, X1 - 8, y + 3, { bold: true, size: bold ? 11 : 10, color });
      y += 24;
    };
    total("Ընդհանուր չվճարված պարտք՝", amd(unpaidTotal), true);
    if (overdueTotal > 0) total("որից ժամկետանց՝", amd(overdueTotal), false, RED);
    y += 6;
    text("Գումարները հաշվարկված են ըստ ընկերության տվյալների (Excel)՝ վճարումները փակում են ամենահին հաշիվները։", X0, y, { size: 7.5, color: "#555555" });
    if (data.synced_at) text(`Տվյալները թարմացվել են՝ ${dmy(data.synced_at)}`, X0, y + 11, { size: 7.5, color: "#555555" });
  });
  if (pages.length > 1) {
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      right(`Էջ ${i + 1}/${range.count}`, X1, 810, { size: 8.5 });
    }
  }
  doc.end();
  return done;
}
