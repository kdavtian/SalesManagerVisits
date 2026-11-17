// Customer volume potential (../volumePotential.js): the card's data, its save, its history, and the product-line catalogue.
// Access is the same rule as the prospect level on the same card (customers.js potentialAccess): management (canManagePotentialAll) any
// customer, a sales manager only the customers assigned to them. The catalogue is read by everyone signed in and changed by management.
import express, { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { pool } from "../../db/pool.js";
import { canManagePotentialAll, canEditCustomerPotential } from "../../shared/roles.js";
import { canAccessReport } from "../../reports/reports.js";
import { customerActuals, actualsWindow, walletOf, skuMappings, saveSkuMapping } from "../volumeActuals.js";
import { buildOpportunities } from "../volumeOpportunities.js";
import { loadVolumePotential, saveVolumePotential, volumePotentialHistory, activeLines, saveLine, VolumePotentialError, SERVICES, VEHICLES, BRANDS } from "../volumePotential.js";

export const volumePotentialRouter = Router();
volumePotentialRouter.use(requireAuth);
volumePotentialRouter.use(express.json());

async function access(req, res) {
  const id = Number(req.params.id);
  const { rows: [c] } = Number.isInteger(id) && id > 0 ? await pool.query("SELECT id, assigned_manager_id, erp_customer_id FROM customers WHERE id = $1", [id]) : { rows: [] };
  if (!c) return res.status(404).json({ error: "Customer not found" }), null;
  if (canEditCustomerPotential(req.user, c.assigned_manager_id)) return c;
  return res.status(403).json({ error: "Not allowed" }), null;
}
const failed = (res, err) => (err instanceof VolumePotentialError ? res.status(err.status).json({ error: err.message }) : null);

// The catalogue and the option lists (one request for the sheet). ?all=1 (management) includes switched-off lines.
volumePotentialRouter.get("/lines", async (req, res) => {
  const all = req.query.all === "1" && canManagePotentialAll(req.user.role);
  res.json({ lines: await activeLines(pool, { all }), services: SERVICES, vehicles: VEHICLES, brands: BRANDS, can_edit_lines: canManagePotentialAll(req.user.role) });
});
volumePotentialRouter.post("/lines", async (req, res) => {
  if (!canManagePotentialAll(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  try {
    res.status(201).json(await saveLine(null, req.body));
  } catch (err) {
    if (!failed(res, err)) throw err;
  }
});
volumePotentialRouter.put("/lines/:lineId", async (req, res) => {
  if (!canManagePotentialAll(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const lineId = Number(req.params.lineId);
  if (!Number.isInteger(lineId) || lineId <= 0) return res.status(400).json({ error: "Bad line" });
  try {
    res.json(await saveLine(lineId, req.body));
  } catch (err) {
    if (!failed(res, err)) throw err;
  }
});

volumePotentialRouter.get("/customers/:id", async (req, res) => {
  const c = await access(req, res);
  if (!c) return;
  const data = await loadVolumePotential(c.id);
  // phase 2: what the customer really buys per line (the last 3 whole months, ERP), share of wallet and gap
  const window = actualsWindow();
  const act = (await customerActuals([c.id], pool, { window })).get(c.id) ?? { by_line: {}, total: 0, unmapped: 0 };
  res.json({ ...data, actuals: { ...act, window, has_erp: Boolean(c.erp_customer_id) }, wallet: walletOf(data, act) });
});
volumePotentialRouter.put("/customers/:id", async (req, res) => {
  const c = await access(req, res);
  if (!c) return;
  try {
    res.json(await saveVolumePotential(c.id, req.user.id, req.body ?? {}));
  } catch (err) {
    if (!failed(res, err)) throw err;
  }
});
volumePotentialRouter.get("/customers/:id/history", async (req, res) => {
  const c = await access(req, res);
  if (!c) return;
  res.json(await volumePotentialHistory(c.id));
});

// ---- phase 2: products -> lines (management), the Opportunities report --------------------------------------------------------------
// GET /skus?status=unmapped|all : every product sold in the last 12 months with its line (or why it has none); the unmapped count
volumePotentialRouter.get("/skus", async (req, res) => {
  if (!canManagePotentialAll(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const all = await skuMappings(pool);
  const counts = { unmapped: 0, auto: 0, manual: 0, not_a_line: 0 };
  for (const m of all) counts[m.status] += 1;
  const rows = req.query.status === "all" ? all : all.filter((m) => m.status === "unmapped");
  rows.sort((a, b) => b.qty_12m - a.qty_12m || String(a.name).localeCompare(String(b.name)));
  res.json({ counts, skus: rows });
});
// PUT /skus/:key { line_id | null, not_a_line, litres_per_unit | null } -- all empty = back to the rules
volumePotentialRouter.put("/skus/:key", async (req, res) => {
  if (!canManagePotentialAll(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  try {
    res.json(await saveSkuMapping(req.params.key, req.user.id, req.body ?? {}));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    throw err;
  }
});
// GET /opportunities?region_sub&lines&reps&services (comma-separated)
volumePotentialRouter.get("/opportunities", async (req, res) => {
  if (!(await canAccessReport(req.user.role, "volume_opportunities"))) return res.status(403).json({ error: "Not allowed" });
  // a sales manager sees their own customers only
  const scopeUserId = canManagePotentialAll(req.user.role) ? null : req.user.id;
  res.json(await buildOpportunities({ query: req.query, scopeUserId }));
});
