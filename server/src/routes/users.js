import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { ROLES, canPlanForOthers } from "../roles.js";
import { passwordChangeLimiter } from "./auth.js";

export const usersRouter = Router();

usersRouter.use(requireAuth);

// Just enough to populate the "plan for" rep picker -- no email/other PII,
// open to any canPlanForOthers role (not admin-only like the rest of this
// router), since a Sales Director planning their team's routes has no
// other reason to need the full admin user-management list.
usersRouter.get(
  "/plannable",
  (req, res, next) => {
    if (!canPlanForOthers(req.user.role)) return res.status(403).json({ error: "Not allowed" });
    next();
  },
  async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, name, position FROM users WHERE role = 'sales_manager' ORDER BY name"
    );
    res.json(rows);
  }
);

usersRouter.use(requireAdmin);

usersRouter.get("/", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, name, role, position, phone, created_at,
            last_seen_at, last_seen_app_version, last_seen_user_agent
     FROM users ORDER BY created_at DESC`
  );
  res.json(rows);
});

// Editable profile fields for an existing staff member -- deliberately not
// role (a role change has broader implications, e.g. re-checking whatever
// that user was assigned/plans/approves elsewhere, so it's out of scope
// for a quick "fix a typo in their phone number" edit) and not password
// (its own endpoint below, with its own rate limit and session-invalidation
// behavior).
const EDITABLE_PROFILE_FIELDS = ["name", "email", "position", "phone"];

usersRouter.patch("/:id", async (req, res) => {
  if (req.body?.email !== undefined && !req.body.email) {
    return res.status(400).json({ error: "Email cannot be empty" });
  }
  if (req.body?.name !== undefined && !req.body.name) {
    return res.status(400).json({ error: "Name cannot be empty" });
  }

  const updates = [];
  const params = [];
  for (const field of EDITABLE_PROFILE_FIELDS) {
    if (req.body?.[field] === undefined) continue;
    const value = field === "email" ? String(req.body.email).toLowerCase() : req.body[field] || null;
    params.push(value);
    updates.push(`${field} = $${params.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: "No editable fields provided" });

  params.push(req.params.id);
  try {
    const { rows } = await pool.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = $${params.length}
       RETURNING id, email, name, role, position, phone, created_at,
                 last_seen_at, last_seen_app_version, last_seen_user_agent`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found" });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "A user with that email already exists" });
    }
    throw err;
  }
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

usersRouter.patch("/:id/password", passwordChangeLimiter, async (req, res) => {
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
