// Daily cash sheet (document flow V1 + V2, owner 2026-10-28; .claude/skills/kadprocesses/references/cash-collection-flow.md).
// Replaces the sales director's hand-written list: when the director confirms a rep's cash hand-off, the sheet is made from the payments in
// it (date, ERP id, customer, amount), the CEO bot posts it to the accounting Telegram group (text + an Excel file whose Cashflow tab has the
// columns of the workbook's Cash table, so the accountant can paste it), the accountant marks it "Recorded in Excel", or the next sync closes
// it by itself when every payment of it is found in the Excel. Control loop: a rep's hand-off still unconfirmed at 20:00, a sheet not recorded
// after 2 days and any counted-amount discrepancy become tasks for the right person (Vaghinak's name on them).
import ExcelJS from "exceljs";
import { pool } from "../db/pool.js";
import { notifyUser } from "../shared/notifications.js";
import { IN_EXCEL_SQL } from "./paymentExcelMatch.js";
import { createOpsTask, closeOpsTasks, usersWithRole } from "../team/opsTasks.js";
import { yerevanToday } from "../utils/yerevanDate.js";
import { isWorkingDay, minuteOfDay } from "../team/vaghinak/engine.js";

export const NOT_RECORDED_DAYS = 2;
export const EVENING_MINUTE = 20 * 60;

// The workbook's Cashflow `Source` for a customer payment ("Oil order"): the rep's cash box by sales channel (same rule as the Excel formula).
const CHANNEL_SOURCE = { "SM YVN": "Cash YVN", "SM Davtashen": "Cash DVT", "SM Shirak": "Cash Shirak" };
export const cashSource = (channel) => CHANNEL_SOURCE[channel] ?? "Cash";

const yerevanDay = (value) => new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Yerevan" });
const dmy = (day) => day.split("-").reverse().join("-");
const amd = (n) => Math.round(Number(n)).toLocaleString("en-US");

// Inside the director's confirm transaction: the sheet of a rep's hand-off (only the first hop -- a rep's cash -- makes one).
export async function createCashSheet(client, handoff, { directorId, countedAmd }) {
  const { rows } = await client.query(
    `INSERT INTO cash_sheets (handoff_id, rep_id, director_id, sheet_date, total_amd, counted_amd, item_count)
     VALUES ($1, $2, $3, (now() AT TIME ZONE 'Asia/Yerevan')::date, $4, $5,
             (SELECT count(*)::int FROM cash_handoff_items WHERE handoff_id = $1))
     ON CONFLICT (handoff_id) DO NOTHING RETURNING id`,
    [handoff.id, handoff.from_user_id, directorId, handoff.amount_amd, countedAmd]
  );
  return rows[0]?.id ?? null;
}

// Everything one sheet shows: the sheet, the people, the payments (oldest first) and the orders the rep delivered himself that day.
export async function loadCashSheet(id, db = pool) {
  const { rows } = await db.query(
    `SELECT s.*, r.name AS rep_name, d.name AS director_name, rb.name AS recorded_by_name, h.discrepancy_note, h.confirmed_at,
            (SELECT p.sales_channel FROM cash_handoff_items i JOIN payments p ON p.id = i.payment_id WHERE i.handoff_id = s.handoff_id
              GROUP BY p.sales_channel ORDER BY count(*) DESC LIMIT 1) AS channel
     FROM cash_sheets s JOIN cash_handoffs h ON h.id = s.handoff_id
     LEFT JOIN users r ON r.id = s.rep_id LEFT JOIN users d ON d.id = s.director_id LEFT JOIN users rb ON rb.id = s.recorded_by
     WHERE s.id = $1`,
    [id]
  );
  const sheet = rows[0];
  if (!sheet) return null;
  const { rows: payments } = await db.query(
    `SELECT p.id, p.payment_date, p.amount_amd, p.erp_customer_id_snapshot AS erp_id, COALESCE(c.name, p.customer_name_snapshot) AS customer_name,
            p.sales_channel, ${IN_EXCEL_SQL} AS in_excel
     FROM cash_handoff_items i JOIN payments p ON p.id = i.payment_id LEFT JOIN customers c ON c.id = p.customer_id
     WHERE i.handoff_id = $1 ORDER BY p.payment_date, p.id`,
    [sheet.handoff_id]
  );
  const { rows: sales } = await db.query(
    `SELECT o.id AS order_id, o.order_code, o.payment_method, c.erp_customer_id AS erp_id, c.name AS customer_name, c.sales_channel,
            oi.brand, oi.product_name, pr.unit, oi.quantity, oi.unit_price_amd, oi.list_price_amd, oi.line_total_amd, pod.delivered_at
     FROM pod_records pod JOIN orders o ON o.id = pod.order_id JOIN customers c ON c.id = o.customer_id
     JOIN order_items oi ON oi.order_id = o.id LEFT JOIN products pr ON pr.id = oi.product_id
     WHERE pod.driver_id = $1 AND (pod.delivered_at AT TIME ZONE 'Asia/Yerevan')::date = $2
     ORDER BY pod.delivered_at, o.id, oi.id`,
    [sheet.rep_id, sheet.sheet_date]
  );
  return { sheet: { ...sheet, sheet_date: yerevanDay(sheet.sheet_date) }, payments, sales };
}

// The Telegram message (Armenian, the accounting group's language): one line per payment, then the total and the count.
export function cashSheetText({ sheet, payments, sales }) {
  const lines = payments.map((p, i) => `${i + 1}. ${dmy(yerevanDay(p.payment_date)).slice(0, 5)} · ${p.erp_id || "—"} · ${p.customer_name} — ${amd(p.amount_amd)}`);
  const diff = Number(sheet.counted_amd) - Number(sheet.total_amd);
  const orders = new Set(sales.map((s) => s.order_id)).size;
  return [
    `💵 Կանխիկի օրաթերթ №${sheet.id} — ${dmy(sheet.sheet_date)}`,
    `Գործակալ՝ ${sheet.rep_name ?? "—"}${sheet.channel ? ` (${sheet.channel})` : ""}`,
    `Ընդունեց՝ ${sheet.director_name ?? "—"}`,
    "",
    ...lines,
    "",
    `Ընդամենը՝ ${amd(sheet.total_amd)} AMD · ${payments.length} վճարում`,
    diff === 0 ? "Հաշվված՝ ✅ համընկնում է" : `⚠️ Հաշվված՝ ${amd(sheet.counted_amd)} AMD (տարբերություն ${diff > 0 ? "+" : "−"}${amd(Math.abs(diff))})${sheet.discrepancy_note ? ` — ${sheet.discrepancy_note}` : ""}`,
    orders ? `Առաքված պատվերներ՝ ${orders} (Excel ֆայլի «Sales» թերթում)` : null,
    "Excel՝ «Cashflow» թերթը նույն սյունակներով է (Date…Info)։",
  ]
    .filter((x) => x !== null)
    .join("\n");
}

export const cashSheetFilename = ({ sheet }) => `cash-sheet-${sheet.sheet_date}-${sheet.id}.xlsx`;

// The Excel file: "Cashflow" = the workbook's Cash table columns A..G in their order (Date, Amount, Currency, For, ID, Source, Info) so the rows
// paste straight in; the name and the rep come after an empty column, for checking only. "Sales" = the orders the rep delivered that day.
export async function cashSheetXlsx({ sheet, payments, sales }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "KAD Motors app";
  const cash = wb.addWorksheet("Cashflow");
  cash.columns = [
    { header: "Date", key: "date", width: 12, style: { numFmt: "dd.mm.yyyy" } },
    { header: "Amount", key: "amount", width: 12, style: { numFmt: "#,##0" } },
    { header: "Currency", key: "currency", width: 9 },
    { header: "For", key: "for", width: 10 },
    { header: "ID", key: "id", width: 9 },
    { header: "Source", key: "source", width: 12 },
    { header: "Info", key: "info", width: 26 },
    { header: "", key: "gap", width: 3 },
    { header: "Customer (check)", key: "customer", width: 30 },
    { header: "Sales Rep (check)", key: "rep", width: 14 },
  ];
  for (const p of payments) {
    const day = yerevanDay(p.payment_date);
    cash.addRow({
      date: new Date(`${day}T00:00:00Z`),
      amount: Math.round(Number(p.amount_amd)),
      currency: "AMD",
      for: "Oil order",
      id: /^\d+$/.test(String(p.erp_id ?? "")) ? Number(p.erp_id) : p.erp_id ?? "",
      source: cashSource(p.sales_channel),
      info: `${sheet.rep_name ?? ""} · app ${p.id} · sheet ${sheet.id}`.trim(),
      customer: p.customer_name,
      rep: p.sales_channel ?? "",
    });
  }
  const total = cash.addRow({ info: "Total", amount: Math.round(Number(sheet.total_amd)) });
  total.font = { bold: true };
  cash.getRow(1).font = { bold: true };
  cash.views = [{ state: "frozen", ySplit: 1 }];

  const s = wb.addWorksheet("Sales");
  s.columns = [
    { header: "Date", key: "date", width: 12, style: { numFmt: "dd.mm.yyyy" } },
    { header: "Customer ID", key: "erp", width: 11 },
    { header: "Company Name", key: "customer", width: 28 },
    { header: "Brand", key: "brand", width: 10 },
    { header: "Product_Name", key: "product", width: 30 },
    { header: "Size", key: "size", width: 8 },
    { header: "Qty", key: "qty", width: 7 },
    { header: "UnitPrice", key: "price", width: 11, style: { numFmt: "#,##0" } },
    { header: "Total", key: "total", width: 12, style: { numFmt: "#,##0" } },
    { header: "Sales_Rep", key: "channel", width: 12 },
    { header: "Payment Method", key: "method", width: 14 },
    { header: "App order", key: "code", width: 14 },
  ];
  for (const l of sales) {
    s.addRow({
      date: new Date(`${yerevanDay(l.delivered_at)}T00:00:00Z`),
      erp: /^\d+$/.test(String(l.erp_id ?? "")) ? Number(l.erp_id) : l.erp_id ?? "",
      customer: l.customer_name,
      brand: l.brand ?? "",
      product: l.product_name,
      size: l.unit ?? "",
      qty: Number(l.quantity),
      price: Math.round(Number(l.unit_price_amd)),
      total: Math.round(Number(l.line_total_amd)),
      channel: l.sales_channel ?? "",
      method: l.payment_method === "cash" ? "Cash" : l.payment_method === "free" ? "Free" : "Invoice",
      code: l.order_code ?? `#${l.order_id}`,
    });
  }
  s.getRow(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// After an Excel sync: a sheet whose payments are all in the Excel is recorded (by the sync). Returns the closed sheet ids.
export async function closeSheetsFoundInExcel(db = pool) {
  const { rows } = await db.query(
    `UPDATE cash_sheets s SET recorded_at = now(), recorded_auto = true
     WHERE s.recorded_at IS NULL AND NOT EXISTS (
       SELECT 1 FROM cash_handoff_items i JOIN payments p ON p.id = i.payment_id WHERE i.handoff_id = s.handoff_id AND NOT ${IN_EXCEL_SQL})
     RETURNING s.id`
  );
  return rows.map((r) => r.id);
}

// A discrepancy is told at once: the owner's side (admin, CEO) gets the notification and a task.
export async function reportDiscrepancy({ handoffId, repName, directorName, expected, counted, note }, db = pool) {
  const diff = Number(counted) - Number(expected);
  const title = `Կանխիկի տարբերություն՝ ${repName} → ${directorName}: ${diff > 0 ? "+" : "−"}${amd(Math.abs(diff))} AMD`;
  const body = [`• Սպասվող՝ ${amd(expected)} AMD`, `• Հաշվված՝ ${amd(counted)} AMD`, note ? `• ${note}` : null].filter(Boolean).join("\n");
  const { rows } = await db.query("SELECT id FROM users WHERE role IN ('admin', 'ceo') AND status = 'active'");
  for (const u of rows) {
    notifyUser(u.id, "fraud_alert", { title, body, url: `/#/cash-handoffs/${handoffId}` }).catch(() => {});
    await createOpsTask({ kind: "cash_discrepancy", title: "Ստուգիր կանխիկի տարբերությունը", assigneeId: u.id, items: [title, body], notify: false, db }).catch(() => {});
  }
}

// Every half hour (opsJobs): the evening check and the "not recorded after 2 days" check, on working days.
export async function runCashSheetJobs(now = new Date(), db = pool) {
  const day = yerevanToday(now);
  const result = { unconfirmed: 0, notRecorded: 0 };
  if (!(await isWorkingDay(db, day))) return result;

  if (minuteOfDay(now) >= EVENING_MINUTE) {
    const { rows } = await db.query(
      `SELECT h.to_user_id, string_agg(fu.name || ' — ' || to_char(h.amount_amd, 'FM999,999,999,990') || ' AMD', '; ') AS list
       FROM cash_handoffs h JOIN users fu ON fu.id = h.from_user_id
       WHERE h.status = 'pending' AND fu.role = 'sales_manager' AND (h.submitted_at AT TIME ZONE 'Asia/Yerevan')::date = $1
       GROUP BY h.to_user_id`,
      [day]
    );
    for (const r of rows) {
      if (await createOpsTask({ kind: "cash_handoff_unconfirmed", title: "Հաստատիր այսօրվա կանխիկի հանձնումը", assigneeId: r.to_user_id, items: [r.list], db })) result.unconfirmed++;
    }
  }

  const { rows: late } = await db.query(
    `SELECT s.id, s.sheet_date, s.total_amd, r.name AS rep_name FROM cash_sheets s LEFT JOIN users r ON r.id = s.rep_id
     WHERE s.recorded_at IS NULL AND s.created_at < now() - make_interval(days => $1) ORDER BY s.id`,
    [NOT_RECORDED_DAYS]
  );
  if (!late.length) await closeOpsTasks("cash_sheet_not_recorded", "Բոլոր օրաթերթերը գրանցված են", db);
  else {
    const items = late.slice(0, 12).map((s) => `№${s.id} · ${dmy(yerevanDay(s.sheet_date))} · ${s.rep_name ?? "—"} · ${amd(s.total_amd)} AMD`);
    let accountants = await usersWithRole("accountant", db);
    if (!accountants.length) accountants = await usersWithRole("admin", db);
    for (const id of accountants) {
      if (await createOpsTask({ kind: "cash_sheet_not_recorded", title: "Գրանցիր կանխիկի օրաթերթերը Excel-ում", assigneeId: id, items, db })) result.notRecorded++;
    }
  }
  return result;
}
