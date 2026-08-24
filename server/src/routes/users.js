import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { ROLES } from "../roles.js";

export const usersRouter = Router();

usersRouter.use(requireAuth, requireAdmin);

usersRouter.get("/", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, email, name, role, position, created_at FROM users ORDER BY created_at DESC"
  );
  res.json(rows);
});

usersRouter.post("/", async (req, res) => {
  const { email, password, name, role, position } = req.body ?? {};

  if (!email || !password || !name || !role) {
    return res
      .status(400)
      .json({ error: "email, password, name and role are required" });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(", ")}` });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role, position)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, role, position, created_at`,
      [String(email).toLowerCase(), passwordHash, name, role, position || null]
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
  // Bumping token_version invalidates any session cookie already issued to
  // this user, so a reset password (e.g. after a suspected compromise)
  // actually logs them out everywhere instead of just changing the hash.
  const { rowCount } = await pool.query(
    "UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2",
    [passwordHash, req.params.id]
  );
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
