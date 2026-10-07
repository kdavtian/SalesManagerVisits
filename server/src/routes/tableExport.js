// Turns a table the user is looking at (already filtered, already loaded in
// the client) into an .xlsx file. Generic on purpose: Sales and Payments (and
// any later list) share one endpoint instead of each duplicating its query.
// Only formats data the caller sent -- it reads nothing from the database, so
// it cannot widen anyone's access.
import { Router } from "express";
import ExcelJS from "exceljs";
import { requireAuth } from "../middleware/auth.js";

export const tableExportRouter = Router();
tableExportRouter.use(requireAuth);

const MAX_ROWS = 20000;
const MAX_COLUMNS = 30;
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

tableExportRouter.post("/xlsx", async (req, res) => {
  const { filename, sheet, columns, rows } = req.body ?? {};
  if (!Array.isArray(columns) || !columns.length || columns.length > MAX_COLUMNS) return res.status(400).json({ error: "Invalid columns" });
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) return res.status(400).json({ error: `At most ${MAX_ROWS} rows` });

  const cols = columns.map((c, i) => ({
    header: String(c?.header ?? "").slice(0, 80),
    key: `c${i}`,
    width: Math.min(60, Math.max(8, Number(c?.width) || 16)),
    type: c?.type === "number" ? "number" : "text",
  }));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "KAD Motors";
  workbook.created = new Date();
  const ws = workbook.addWorksheet(String(sheet || "Export").replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Export", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = cols.map(({ header, key, width }) => ({ header, key, width }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF1F5" } };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  cols.forEach((c, i) => {
    if (c.type === "number") ws.getColumn(i + 1).numFmt = "#,##0.##";
  });
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const row = {};
    cols.forEach((c, i) => {
      const v = r[i];
      if (c.type === "number") row[c.key] = v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
      else row[c.key] = v === null || v === undefined ? "" : String(v).slice(0, 500);
    });
    ws.addRow(row);
  }

  const safeName = String(filename || "export").replace(/[^\w.-]+/g, "_").replace(/\.xlsx$/i, "").slice(0, 60) || "export";
  res.setHeader("Content-Type", XLSX_TYPE);
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});
