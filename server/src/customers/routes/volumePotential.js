// Customer volume potential (../volumePotential.js): the card's data, its save, its history, and the product-line catalogue.
// Access is the same rule as the prospect level on the same card (customers.js potentialAccess): management (canManagePotentialAll) any
// customer, a sales manager only the customers assigned to them. The catalogue is read by everyone signed in and changed by management.
import express, { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { pool } from "../../db/pool.js";
import { canManagePotentialAll } from "../../shared/roles.js";
import { loadVolumePotential, saveVolumePotential, volumePotentialHistory, activeLines, saveLine, VolumePotentialError, SERVICES, VEHICLES, BRANDS } from "../volumePotential.js";

export const volumePotentialRouter = Router();
volumePotentialRouter.use(requireAuth);
volumePotentialRouter.use(express.json());

async function access(req, res) {
  const id = Number(req.params.id);
  const { rows: [c] } = Number.isInteger(id) && id > 0 ? await pool.query("SELECT id, assigned_manager_id FROM customers WHERE id = $1", [id]) : { rows: [] };
  if (!c) return res.status(404).json({ error: "Customer not found" }), null;
  if (canManagePotentialAll(req.user.role) || (req.user.role === "sales_manager" && c.assigned_manager_id === req.user.id)) return c;
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
  res.json(await loadVolumePotential(c.id));
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
