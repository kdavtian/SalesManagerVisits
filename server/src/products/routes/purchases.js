// /api/purchases -- the Purchases module (products/purchases.js): supplier invoices typed in the app and compared with the Excel
// Purchase_IN rows. Costs are in it: admin, CEO, operations director and the accountant (canManagePurchases).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Router } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { uploadDirPath } from "../../shared/upload.js";
import { requireAuth } from "../../middleware/auth.js";
import { canManagePurchases, canDeletePurchases } from "../../shared/roles.js";
import { pool } from "../../db/pool.js";
import { savePurchase, listPurchases, getPurchase, listSuppliers, getExcelInvoice, excelStatus, productHistory, applyExcelPurchases, PurchaseError, invoiceFacts, logPurchase, exportPurchaseRows } from "../purchases.js";
import { parsePurchaseWorkbook } from "../purchaseExcel.js";

export const purchasesRouter = Router();
purchasesRouter.use(requireAuth);
purchasesRouter.use((req, res, next) => (canManagePurchases(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" })));

const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : null);
const fail = (res, err) => {
  // the same supplier's same invoice number and date again: 409 with the one that exists (the form shows "open it" and "Save anyway")
  if (err instanceof PurchaseError && err.code === "duplicate") return res.status(409).json({ error: err.message, code: "duplicate", existing_id: err.existingId });
  if (err instanceof PurchaseError) return res.status(400).json({ error: err.message });
  throw err;
};
const workbookUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

// The paper of an invoice (owner plan P3, 2026-11-20): photos or a PDF, at most 5 at once, 15 MB each, kept under uploads/purchases.
const PURCHASE_FILE_MIME = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
const purchaseFilesDir = path.join(uploadDirPath, "purchases");
fs.mkdirSync(purchaseFilesDir, { recursive: true });
const purchaseFileUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, purchaseFilesDir),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}.${PURCHASE_FILE_MIME[file.mimetype] || "bin"}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => (PURCHASE_FILE_MIME[file.mimetype] ? cb(null, true) : cb(new PurchaseError("Only a photo (JPEG, PNG, WebP) or a PDF"))),
});
const dropFile = (name) => fs.unlink(path.join(purchaseFilesDir, path.basename(String(name))), () => {});

// Excel export of the period (owner plan P3): one row per line, app and Excel-only invoices
purchasesRouter.get("/export.xlsx", async (req, res) => {
  const rows = await exportPurchaseRows({ from: day(req.query.from), to: day(req.query.to) });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Purchases");
  ws.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Invoice", key: "invoice_no", width: 14 },
    { header: "Supplier", key: "supplier", width: 22 },
    { header: "Status", key: "status", width: 12 },
    { header: "Brand", key: "brand", width: 12 },
    { header: "Product", key: "product", width: 36 },
    { header: "Size, L", key: "size_l", width: 9 },
    { header: "Packs", key: "qty", width: 9 },
    { header: "USD per pack", key: "cost_usd", width: 13 },
    { header: "USD", key: "usd", width: 13 },
    { header: "Liters", key: "liters", width: 10 },
    { header: "USD rate", key: "usd_rate", width: 10 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const r of rows) ws.addRow(r);
  for (const k of ["cost_usd", "usd"]) ws.getColumn(k).numFmt = "#,##0.00";
  ws.getColumn("qty").numFmt = "#,##0.###";
  const name = `purchases_${day(req.query.from) ?? "all"}_${day(req.query.to) ?? new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.end(Buffer.from(await wb.xlsx.writeBuffer()));
});

// one file of an invoice, shown in the browser (a photo or the PDF)
purchasesRouter.get("/files/:fileId", async (req, res) => {
  const { rows: [f] } = await pool.query("SELECT file_path, mime, original_name FROM purchase_files WHERE id = $1", [Number(req.params.fileId) || 0]);
  if (!f) return res.status(404).json({ error: "File not found" });
  const full = path.join(purchaseFilesDir, path.basename(f.file_path));
  if (!fs.existsSync(full)) return res.status(404).json({ error: "File not found" });
  res.setHeader("Content-Type", f.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(f.original_name || path.basename(f.file_path))}"`);
  res.setHeader("Cache-Control", "private, max-age=86400");
  fs.createReadStream(full).pipe(res);
});

// add photos / a PDF to an invoice
purchasesRouter.post("/:id/files", (req, res, next) =>
  purchaseFileUpload.array("files", 5)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err instanceof PurchaseError ? err.message : err.code === "LIMIT_FILE_SIZE" ? "A file is larger than 15 MB" : "Could not read the file" });
    next();
  }),
  async (req, res) => {
    const id = Number(req.params.id);
    const files = req.files ?? [];
    const facts = Number.isInteger(id) ? await invoiceFacts(pool, id) : null;
    if (!facts) {
      files.forEach((f) => dropFile(f.filename));
      return res.status(404).json({ error: "Purchase not found" });
    }
    if (!files.length) return res.status(400).json({ error: "Choose a photo or a PDF" });
    for (const f of files) {
      await pool.query(
        "INSERT INTO purchase_files (invoice_id, file_path, mime, size_bytes, original_name, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, f.filename, f.mimetype, f.size, String(f.originalname ?? "").slice(0, 200) || null, req.user.id]
      );
    }
    await logPurchase(pool, { invoiceId: id, action: "file_add", userId: req.user.id, facts, details: { files: files.map((f) => String(f.originalname ?? "").slice(0, 200)) } });
    res.status(201).json(await getPurchase(id));
  }
);

purchasesRouter.delete("/files/:fileId", async (req, res) => {
  const { rows: [f] } = await pool.query("DELETE FROM purchase_files WHERE id = $1 RETURNING invoice_id, file_path, original_name", [Number(req.params.fileId) || 0]);
  if (!f) return res.status(404).json({ error: "File not found" });
  dropFile(f.file_path);
  await logPurchase(pool, { invoiceId: f.invoice_id, action: "file_delete", userId: req.user.id, facts: await invoiceFacts(pool, f.invoice_id), details: { files: [f.original_name] } });
  res.status(204).end();
});

purchasesRouter.get("/", async (req, res) => {
  const supplierId = Number(req.query.supplier_id) || null;
  res.json(await listPurchases({ from: day(req.query.from), to: day(req.query.to), supplierId }));
});

purchasesRouter.get("/suppliers", async (_req, res) => {
  res.json(await listSuppliers());
});

purchasesRouter.post("/suppliers", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "The supplier name is required" });
  const { rows } = await pool.query(
    `INSERT INTO suppliers (name, brands) VALUES ($1, $2)
     ON CONFLICT (lower(name)) DO UPDATE SET brands = COALESCE(EXCLUDED.brands, suppliers.brands), active = true RETURNING *`,
    [name.slice(0, 120), req.body?.brands ? String(req.body.brands).slice(0, 200) : null]
  );
  res.status(201).json(rows[0]);
});

// What the Excel copy holds and when it arrived (the screen says so, and offers the file import while it is empty).
purchasesRouter.get("/status", async (_req, res) => {
  res.json(await excelStatus());
});

// What was bought before, per product (?ids=1,2,3): last purchase, the one before, 12-month totals, stock now -- shown beside each form line.
purchasesRouter.get("/product-history", async (req, res) => {
  const ids = String(req.query.ids ?? "").split(",").map(Number).filter(Number.isInteger);
  // ?exclude_no=&exclude_date= leaves one invoice out (the one being edited or copied: its own lines are not "bought before")
  res.json(await productHistory(ids, { excludeNo: req.query.exclude_no ? String(req.query.exclude_no) : null, excludeDate: day(req.query.exclude_date) }));
});

// The Purchase_IN sheet from the Castrol workbook, uploaded by hand: replaces the Excel copy exactly as the bot's push does (owner, 2026-11-07).
purchasesRouter.post("/import-excel", (req, res, next) => {
  workbookUpload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "The file is larger than 25 MB" : "The file could not be uploaded" });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose the Excel file" });
  try {
    const parsed = await parsePurchaseWorkbook(req.file.buffer);
    const stored = await applyExcelPurchases(parsed.rows);
    const status = await excelStatus();
    res.json({ ...stored, skipped: stored.skipped + parsed.skipped, sheet: parsed.sheet, invoices: status.excel_invoices, from: status.from, to: status.to });
  } catch (err) {
    fail(res, err);
  }
});

// One invoice as the Excel has it (?invoice_no=&date=): for an invoice that is only in the Excel, and for copying it into the app.
purchasesRouter.get("/excel-invoice", async (req, res) => {
  const date = day(req.query.date);
  if (!date || !req.query.invoice_no) return res.status(400).json({ error: "invoice_no and date are required" });
  res.json(await getExcelInvoice(String(req.query.invoice_no), date, undefined, req.query.supplier ? String(req.query.supplier).slice(0, 120) : null));
});

purchasesRouter.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  const purchase = await getPurchase(id);
  if (!purchase) return res.status(404).json({ error: "Purchase not found" });
  res.json(purchase);
});

purchasesRouter.post("/", async (req, res) => {
  try {
    const id = await savePurchase(req.body, req.user.id);
    res.status(201).json(await getPurchase(id));
  } catch (err) {
    fail(res, err);
  }
});

purchasesRouter.put("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  try {
    await savePurchase(req.body, req.user.id, id);
    res.json(await getPurchase(id));
  } catch (err) {
    if (err instanceof PurchaseError && err.message === "Purchase not found") return res.status(404).json({ error: err.message });
    fail(res, err);
  }
});

// A mistaken invoice (typed twice, wrong supplier): only the admin / CEO delete one (canDeletePurchases).
purchasesRouter.delete("/:id", async (req, res) => {
  if (!canDeletePurchases(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const id = Number(req.params.id) || 0;
  const facts = await invoiceFacts(pool, id);
  const { rows: files } = await pool.query("SELECT file_path FROM purchase_files WHERE invoice_id = $1", [id]);
  const { rowCount } = await pool.query("DELETE FROM purchase_invoices WHERE id = $1", [id]);
  if (!rowCount) return res.status(404).json({ error: "Purchase not found" });
  files.forEach((f) => dropFile(f.file_path));
  // the history stays after the invoice is gone (purchase_log has no foreign key to it)
  await logPurchase(pool, { invoiceId: id, action: "delete", userId: req.user.id, facts, details: { before: facts ? { lines: facts.lines, packs: facts.packs, usd: Math.round(facts.usd * 100) / 100 } : null } });
  res.status(204).end();
});
