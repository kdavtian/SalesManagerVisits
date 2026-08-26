import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { seesFinancialExports } from "../roles.js";

export const cashExpensesRouter = Router();

cashExpensesRouter.use(requireAuth);

// A manager sees only their own spend; director/ceo/accountant/admin see
// everyone's -- same visibility line as the financial CSV exports, since
// this is the same kind of money-reporting data.
cashExpensesRouter.get("/", async (req, res) => {
  const params = [];
  let where = "";
  if (!seesFinancialExports(req.user.role)) {
    params.push(req.user.id);
    where = `WHERE ce.user_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT ce.*, u.name AS user_name
     FROM cash_expenses ce
     JOIN users u ON u.id = ce.user_id
     ${where}
     ORDER BY ce.created_at DESC`,
    params
  );
  res.json(rows);
});

cashExpensesRouter.post("/", async (req, res) => {
  const amount = Number(req.body?.amount_amd);
  const purpose = (req.body?.purpose ?? "").trim();
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "amount_amd must be a positive number" });
  }
  if (!purpose) {
    return res.status(400).json({ error: "purpose is required" });
  }
  const { rows } = await pool.query(
    `INSERT INTO cash_expenses (user_id, amount_amd, purpose) VALUES ($1, $2, $3) RETURNING *`,
    [req.user.id, amount, purpose]
  );
  res.status(201).json(rows[0]);
});

// Editable/deletable by the rep who logged it, or admin -- not by a
// director/ceo/accountant just because they can see it; they consume this
// as a report, they don't get to alter someone else's expense record.
async function canModify(req, res, next) {
  const { rows } = await pool.query("SELECT user_id FROM cash_expenses WHERE id = $1", [req.params.id]);
  const expense = rows[0];
  if (!expense) return res.status(404).json({ error: "Expense not found" });
  if (expense.user_id !== req.user.id && req.user.role !== "admin") {
    return res.status(403).json({ error: "Not allowed" });
  }
  next();
}

cashExpensesRouter.patch("/:id", canModify, async (req, res) => {
  const updates = [];
  const params = [];
  if (req.body?.amount_amd !== undefined) {
    const amount = Number(req.body.amount_amd);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "amount_amd must be a positive number" });
    }
    params.push(amount);
    updates.push(`amount_amd = $${params.length}`);
  }
  if (req.body?.purpose !== undefined) {
    const purpose = String(req.body.purpose).trim();
    if (!purpose) return res.status(400).json({ error: "purpose cannot be empty" });
    params.push(purpose);
    updates.push(`purpose = $${params.length}`);
  }
  if (!updates.length) {
    return res.status(400).json({ error: "amount_amd or purpose is required" });
  }
  updates.push("updated_at = now()");
  params.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE cash_expenses SET ${updates.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );
  res.json(rows[0]);
});

cashExpensesRouter.delete("/:id", canModify, async (req, res) => {
  await pool.query("DELETE FROM cash_expenses WHERE id = $1", [req.params.id]);
  res.status(204).end();
});
