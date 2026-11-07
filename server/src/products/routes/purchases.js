// /api/purchases -- the Purchases module (products/purchases.js): supplier invoices typed in the app and compared with the Excel
// Purchase_IN rows. Costs are in it: admin, CEO, operations director and the accountant (canManagePurchases).
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { canManagePurchases, canDeletePurchases } from "../../shared/roles.js";
import { pool } from "../../db/pool.js";
import { savePurchase, listPurchases, getPurchase, listSuppliers, getExcelInvoice, PurchaseError } from "../purchases.js";

export const purchasesRouter = Router();
purchasesRouter.use(requireAuth);
purchasesRouter.use((req, res, next) => (canManagePurchases(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" })));

const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? "")) ? String(v) : null);
const fail = (res, err) => {
  if (err instanceof PurchaseError) return res.status(400).json({ error: err.message });
  throw err;
};

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
