// The Pivot report (owner, 2026-11-03): pick a data source, put fields on rows / columns / values, filter anything, or list the chosen
// fields row by row; save the setup (private or shared) and export Excel / CSV / PDF. Admin and CEO only (roles.js usesPivot).
//   GET  /sources              the data sources and their fields (no SQL)
//   POST /run      { spec }    the result (reports/pivot/query.js)
//   POST /values   { spec, field, q?, bucket? }  distinct values of a field (for the filter picker), with counts
//   GET/POST/PATCH/DELETE /views[/:id]          saved setups
//   POST /export   { format: xlsx|pdf, title, subtitle?, header, rows, total? }  the table the screen shows, as a file (CSV is made by the screen)
import { Router } from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import path from "node:path";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { usesPivot } from "../../shared/roles.js";
import { ASSETS_DIR } from "../../shared/paths.js";
import { catalog } from "../pivot/sources.js";
import { runSpec, distinctValues, SpecError } from "../pivot/query.js";
import { listViews, createView, viewOwner, updateView, deleteView } from "../pivot/views.js";

export const pivotRouter = Router();
pivotRouter.use(requireAuth);
pivotRouter.use((req, res, next) => (usesPivot(req.user.role) ? next() : res.status(403).json({ error: "Only admin and the CEO open the Pivot report" })));

const fail = (res, err) => {
  if (err instanceof SpecError) return res.status(400).json({ error: err.message });
  if (err.code === "57014") return res.status(400).json({ error: "The report took too long: add a filter or fewer fields" });
  throw err;
};

pivotRouter.get("/sources", (_req, res) => res.json({ sources: catalog() }));

pivotRouter.post("/run", async (req, res) => {
  try {
    res.json(await runSpec(pool, req.body?.spec));
  } catch (err) {
    fail(res, err);
  }
});

pivotRouter.post("/values", async (req, res) => {
  try {
    res.json({ values: await distinctValues(pool, req.body?.spec, String(req.body?.field ?? ""), String(req.body?.q ?? "").slice(0, 80), req.body?.bucket ?? null) });
  } catch (err) {
    fail(res, err);
  }
});

// ---- saved setups (the queries: reports/pivot/views.js) ----
const cleanName = (raw) => String(raw ?? "").trim().slice(0, 120);
const cleanConfig = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const text = JSON.stringify(raw);
  return text.length <= 50000 ? raw : null;
};
const withMine = (view, userId) => ({ ...view, mine: view.owner_id === userId });

pivotRouter.get("/views", async (req, res) => {
  res.json({ views: (await listViews(pool, req.user.id)).map((v) => withMine(v, req.user.id)) });
});

pivotRouter.post("/views", async (req, res) => {
  const name = cleanName(req.body?.name);
  const config = cleanConfig(req.body?.config);
  if (!name) return res.status(400).json({ error: "Give the view a name" });
  if (!config) return res.status(400).json({ error: "Nothing to save" });
  const view = await createView(pool, { name, ownerId: req.user.id, config, shared: req.body?.shared === true });
  res.status(201).json({ view: withMine(view, req.user.id) });
});

// the owner changes their own view; admin may change or delete any (a shared view whose owner left)
async function editable(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" }) && null;
  const view = await viewOwner(pool, id);
  if (!view) return res.status(404).json({ error: "View not found" }) && null;
  if (view.owner_id !== req.user.id && req.user.role !== "admin") return res.status(403).json({ error: "Only the person who saved it changes it" }) && null;
  return view;
}

pivotRouter.patch("/views/:id", async (req, res) => {
  const view = await editable(req, res);
  if (!view) return;
  const changes = {};
  if (req.body?.name !== undefined) {
    changes.name = cleanName(req.body.name);
    if (!changes.name) return res.status(400).json({ error: "Give the view a name" });
  }
  if (req.body?.config !== undefined) {
    changes.config = cleanConfig(req.body.config);
    if (!changes.config) return res.status(400).json({ error: "Nothing to save" });
  }
  if (req.body?.shared !== undefined) changes.shared = req.body.shared === true;
  res.json({ view: withMine(await updateView(pool, view.id, changes), req.user.id) });
});

pivotRouter.delete("/views/:id", async (req, res) => {
  const view = await editable(req, res);
  if (!view) return;
  res.json({ deleted: await deleteView(pool, view.id) });
});

// ---- export: the table exactly as the screen shows it ----
const MAX_EXPORT_ROWS = 50000;
const MAX_EXPORT_COLS = 200;
const cellText = (v) => (v == null ? "" : String(v).slice(0, 500));

pivotRouter.post("/export", async (req, res) => {
  const { format, title, subtitle, header, rows, total, numeric } = req.body ?? {};
  const sub = String(subtitle ?? "").slice(0, 1000);
  if (!Array.isArray(header) || !header.length || header.length > MAX_EXPORT_COLS) return res.status(400).json({ error: "Invalid columns" });
  if (!Array.isArray(rows) || rows.length > MAX_EXPORT_ROWS) return res.status(400).json({ error: `At most ${MAX_EXPORT_ROWS} rows` });
  const isNum = (i) => Array.isArray(numeric) && numeric[i] === true;
  const name = String(title || "Pivot").replace(/[^\p{L}\p{N} _.-]/gu, "").slice(0, 60) || "Pivot";
  const all = [...rows, ...(Array.isArray(total) ? [total] : [])];
  if (format === "xlsx") {
    const wb = new ExcelJS.Workbook();
    wb.creator = "KAD Motors";
    const ws = wb.addWorksheet(name.slice(0, 31));
    ws.addRow(header.map(cellText)).font = { bold: true };
    for (const r of all) ws.addRow((Array.isArray(r) ? r : []).slice(0, header.length).map((v, i) => (isNum(i) && v !== "" && v != null && Number.isFinite(Number(v)) ? Number(v) : cellText(v))));
    if (Array.isArray(total)) ws.lastRow.font = { bold: true };
    header.forEach((h, i) => {
      const col = ws.getColumn(i + 1);
      col.width = Math.min(50, Math.max(10, String(h).length + 2));
      if (isNum(i)) col.numFmt = "#,##0.##";
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];
    // the setup on a sheet of its own: the table sheet stays a clean table (Excel's own filter / pivot work on it as is)
    if (sub) {
      const info = wb.addWorksheet("Info");
      info.addRow([String(title || "Pivot")]).font = { bold: true };
      info.addRow([sub]);
      info.getColumn(1).width = 100;
    }
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="pivot.xlsx"`);
    await wb.xlsx.write(res);
    return res.end();
  }
  if (format === "pdf") {
    if (all.length > 5000) return res.status(400).json({ error: "A PDF holds at most 5,000 rows: use Excel for more" });
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 28 });
    doc.registerFont("R", path.join(ASSETS_DIR, "fonts", "DejaVuSans.ttf"));
    doc.registerFont("B", path.join(ASSETS_DIR, "fonts", "DejaVuSans-Bold.ttf"));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="pivot.pdf"`);
    doc.pipe(res);
    const width = doc.page.width - 56;
    const colW = Math.max(40, width / header.length);
    const size = header.length > 12 ? 6 : header.length > 7 ? 7 : 8;
    doc.font("B").fontSize(12).text(String(title || "Pivot"), { width });
    if (sub) doc.font("R").fontSize(8).fillColor("#666666").text(sub, { width }).fillColor("#000000");
    doc.moveDown(0.5);
    const line = (cells, bold) => {
      const h = Math.max(...cells.map((v, i) => doc.font(bold ? "B" : "R").fontSize(size).heightOfString(cellText(v), { width: colW - 4 }))) + 4;
      if (doc.y + h > doc.page.height - 28) doc.addPage();
      const y = doc.y;
      cells.forEach((v, i) => {
        doc.font(bold ? "B" : "R").fontSize(size).text(cellText(v), 28 + i * colW + 2, y + 2, { width: colW - 4, align: isNum(i) ? "right" : "left" });
      });
      doc.moveTo(28, y + h).lineTo(28 + colW * cells.length, y + h).lineWidth(0.3).strokeColor("#cccccc").stroke();
      doc.x = 28;
      doc.y = y + h;
    };
    line(header, true);
    rows.forEach((r) => line(Array.isArray(r) ? r.slice(0, header.length) : [], false));
    if (Array.isArray(total)) line(total.slice(0, header.length), true);
    doc.end();
    return undefined;
  }
  res.status(400).json({ error: "Unknown format" });
});
