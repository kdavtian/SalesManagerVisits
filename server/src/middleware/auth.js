import jwt from "jsonwebtoken";
import { pool } from "../db/pool.js";
import { canDeleteOrEditDirectly, canViewTeamLocations, canManageProducts } from "../roles.js";

const COOKIE_NAME = "session";

export function issueSession(res, user) {
  const token = jwt.sign(
    { sub: user.id, tokenVersion: user.token_version },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE_NAME);
}

// Re-checks the DB on every request (not just role/signature from the JWT)
// so a deleted account or a password reset takes effect immediately instead
// of the old cookie continuing to work for up to its 30-day expiry.
export async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  const { rows } = await pool.query(
    "SELECT id, role, position, token_version FROM users WHERE id = $1",
    [payload.sub]
  );
  const user = rows[0];
  if (!user || user.token_version !== payload.tokenVersion) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }

  req.user = { id: user.id, role: user.role, position: user.position };
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

// Direct customer edits/deletes are admin-only; every other role can only
// propose an edit request for admin to review.
export function requireDirectEditAccess(req, res, next) {
  if (!canDeleteOrEditDirectly(req.user?.role)) {
    return res.status(403).json({ error: "Only admins can apply this directly" });
  }
  next();
}

export function requireLocationViewer(req, res, next) {
  if (!canViewTeamLocations(req.user?.role)) {
    return res.status(403).json({ error: "Not allowed" });
  }
  next();
}

// Product/pricing management -- admin/ceo/accountant (see canManageProducts).
// Broader than requireAdmin: the CEO's own spec puts full pricing control
// in the accountant's hands day to day, not just admin's.
export function requireProductManager(req, res, next) {
  if (!canManageProducts(req.user?.role)) {
    return res.status(403).json({ error: "Not allowed" });
  }
  next();
}
