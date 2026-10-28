// Expense analysis for management (admin, CEO, operations director, accountant): the numbers, findings, weekly reports and recommendations Vaghinak
// builds from the Excel cashflow (see expenseWatch.js).
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { EXPENSE_ROLES, expenseOverview, runExpenseWatch } from "../expenseWatch.js";

export const expensesRouter = Router();
expensesRouter.use(requireAuth);
expensesRouter.use((req, res, next) => (EXPENSE_ROLES.includes(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" })));

expensesRouter.get("/", async (_req, res) => res.json(await expenseOverview()));

expensesRouter.post("/alerts/:id/dismiss", async (req, res) => {
  const { rowCount } = await pool.query(
    "UPDATE expense_alerts SET status = 'dismissed', resolved_at = now(), resolved_by = $2, updated_at = now() WHERE id = $1 AND status = 'open'",
    [req.params.id, req.user.id]
  );
  if (!rowCount) return res.status(404).json({ error: "Finding not found or already closed" });
  res.json({ ok: true });
});

expensesRouter.post("/run-now", async (_req, res) => res.json(await runExpenseWatch()));
