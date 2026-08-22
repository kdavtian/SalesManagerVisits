import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { issueSession, clearSession, requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const { rows } = await pool.query(
    "SELECT id, email, password_hash, name, role FROM users WHERE email = $1",
    [String(email).toLowerCase()]
  );
  const user = rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  issueSession(res, user);
  res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
});

authRouter.post("/logout", (req, res) => {
  clearSession(res);
  res.status(204).end();
});

export const meRouter = Router();

meRouter.get("/", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, email, name, role, created_at FROM users WHERE id = $1",
    [req.user.id]
  );
  if (!rows[0]) {
    return res.status(401).json({ error: "User no longer exists" });
  }
  res.json(rows[0]);
});
