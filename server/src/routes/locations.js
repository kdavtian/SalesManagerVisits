import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth, requireLocationViewer } from "../middleware/auth.js";
import { broadcastsLocation } from "../roles.js";

export const locationsRouter = Router();

locationsRouter.use(requireAuth);

// Foreground-only: the client only calls this while the app is open and
// visible, never from a background service worker. See README.
locationsRouter.post("/", async (req, res) => {
  if (!broadcastsLocation(req.user.role)) {
    return res.status(403).json({ error: "Not allowed" });
  }
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: "lat and lng are required" });
  }

  await pool.query(
    `INSERT INTO user_locations (user_id, lat, lng, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, updated_at = now()`,
    [req.user.id, lat, lng]
  );
  res.status(204).end();
});

// Only shows users seen in the last 10 minutes, so a closed app doesn't
// leave a stale pin behind forever.
locationsRouter.get("/", requireLocationViewer, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ul.user_id, ul.lat, ul.lng, ul.updated_at, u.name, u.role
     FROM user_locations ul
     JOIN users u ON u.id = ul.user_id
     WHERE ul.updated_at >= now() - interval '10 minutes'
     ORDER BY ul.updated_at DESC`
  );
  res.json(rows);
});
