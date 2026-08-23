import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

export const usersRouter = Router();

usersRouter.use(requireAuth, requireAdmin);

usersRouter.get("/", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC"
  );
  res.json(rows);
});

usersRouter.post("/", async (req, res) => {
  const { email, password, name, role } = req.body ?? {};

  if (!email || !password || !name || !role) {
    return res
      .status(400)
      .json({ error: "email, password, name and role are required" });
  }
  if (!["admin", "manager"].includes(role)) {
    return res.status(400).json({ error: "role must be 'admin' or 'manager'" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, name, role, created_at`,
      [String(email).toLowerCase(), passwordHash, name, role]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "A user with that email already exists" });
    }
    throw err;
  }
});

usersRouter.patch("/:id/password", async (req, res) => {
  const password = req.body?.password;
  if (!password || password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { rowCount } = await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
    passwordHash,
    req.params.id,
  ]);
  if (!rowCount) return res.status(404).json({ error: "User not found" });
  res.status(204).end();
});

usersRouter.delete("/:id", async (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ error: "You can't delete your own account" });
  }
  const { rowCount } = await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "User not found" });
  res.status(204).end();
});
