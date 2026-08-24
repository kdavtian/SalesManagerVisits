import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { pool } from "../db/pool.js";
import { issueSession, clearSession, requireAuth } from "../middleware/auth.js";
import { photoUpload, uploadDirPath } from "../upload.js";

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." },
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }

  const { rows } = await pool.query(
    "SELECT id, email, password_hash, name, role, token_version FROM users WHERE email = $1",
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
    "SELECT id, email, name, role, position, avatar_path IS NOT NULL AS has_avatar, created_at FROM users WHERE id = $1",
    [req.user.id]
  );
  if (!rows[0]) {
    return res.status(401).json({ error: "User no longer exists" });
  }
  res.json(rows[0]);
});

const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." },
});

// Self-service password change -- distinct from the admin-only
// PATCH /api/users/:id/password (which resets *someone else's* password
// without knowing the old one). This requires the current password.
meRouter.patch("/password", requireAuth, passwordChangeLimiter, async (req, res) => {
  const { current_password, new_password } = req.body ?? {};
  if (!current_password || !new_password || new_password.length < 8) {
    return res.status(400).json({ error: "current_password and a new_password of at least 8 characters are required" });
  }

  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(current_password, user.password_hash))) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  const passwordHash = await bcrypt.hash(new_password, 10);
  const { rows: updated } = await pool.query(
    `UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2
     RETURNING id, role, token_version`,
    [passwordHash, req.user.id]
  );
  // Bumping token_version logs out every other session, but this device
  // should stay signed in -- reissue a session carrying the new version.
  issueSession(res, updated[0]);
  res.status(204).end();
});

// Bumps token_version (invalidating every session cookie already issued to
// this account) and immediately reissues one for the current device, so
// "log out everywhere else" doesn't also log out the device you're using.
meRouter.post("/logout-other-sessions", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING id, role, token_version",
    [req.user.id]
  );
  issueSession(res, rows[0]);
  res.status(204).end();
});

meRouter.post("/avatar", requireAuth, (req, res, next) => {
  photoUpload.single("avatar")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "avatar file is required" });

  const { rows } = await pool.query("SELECT avatar_path FROM users WHERE id = $1", [req.user.id]);
  const previousPath = rows[0]?.avatar_path;

  await pool.query("UPDATE users SET avatar_path = $1 WHERE id = $2", [req.file.filename, req.user.id]);
  if (previousPath) fs.unlink(path.join(uploadDirPath, previousPath), () => {});
  res.status(201).json({ ok: true });
});

meRouter.get("/avatar", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT avatar_path FROM users WHERE id = $1", [req.user.id]);
  const avatarPath = rows[0]?.avatar_path;
  if (!avatarPath) return res.status(404).json({ error: "No avatar set" });
  res.sendFile(path.join(uploadDirPath, avatarPath), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Avatar not found" });
  });
});

meRouter.delete("/avatar", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT avatar_path FROM users WHERE id = $1", [req.user.id]);
  const avatarPath = rows[0]?.avatar_path;
  if (!avatarPath) return res.status(404).json({ error: "No avatar set" });

  fs.unlink(path.join(uploadDirPath, avatarPath), () => {});
  await pool.query("UPDATE users SET avatar_path = NULL WHERE id = $1", [req.user.id]);
  res.status(204).end();
});
