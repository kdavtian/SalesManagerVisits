import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { getLockdownState, setLockdown } from "../settings.js";

export const lockdownRouter = Router();

// Unauthenticated on purpose: the client needs to know whether it's locked
// down before it can even render a login screen, and a device that's
// already locked out can't carry a valid session to authenticate with.
lockdownRouter.get("/", async (req, res) => {
  const { enabled, byName, at } = await getLockdownState();
  res.json({ enabled, by_name: enabled ? byName : null, at: enabled ? at : null });
});

lockdownRouter.post("/engage", requireAuth, requireAdmin, async (req, res) => {
  // Bumping every user's token_version invalidates every session cookie
  // app-wide in one shot, including the admin's own -- see auth.js, every
  // request re-checks this column against the JWT on each request. That's
  // deliberate: "emergency disconnect" means everyone gets logged out, not
  // everyone except the person who pressed the button.
  await pool.query("UPDATE users SET token_version = token_version + 1");
  await setLockdown(true, req.user.id);
  res.json({ enabled: true });
});

lockdownRouter.post("/lift", requireAuth, requireAdmin, async (req, res) => {
  await setLockdown(false, null);
  res.json({ enabled: false });
});
