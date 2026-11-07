// /api/purchases -- the Purchases module (products/purchases.js): supplier invoices typed in the app and compared with the Excel
// Purchase_IN rows. Costs are in it: admin, CEO, operations director and the accountant (canManagePurchases).
import { Router } from "express";
import multer from "multer";
import { requireAuth } from "../../middleware/auth.js";
import { canManagePurchases, canDeletePurchases } from "../../shared/roles.js";
import { pool } from "../../db/pool.js";
import { savePurchase, listPurchases, getPurchase, listSuppliers, getExcelInvoice, excelStatus, productHistory, applyExcelPurchases, PurchaseError } from "../purchases.js";
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
  res.json(await getExcelInvoice(String(req.query.invoice_no), date));
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
  const { rowCount } = await pool.query("DELETE FROM purchase_invoices WHERE id = $1", [Number(req.params.id) || 0]);
  if (!rowCount) return res.status(404).json({ error: "Purchase not found" });
  res.status(204).end();
});
