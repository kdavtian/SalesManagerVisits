import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { getCheckinRadiusMeters, setCheckinRadiusMeters } from "../settings.js";

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

settingsRouter.get("/", async (req, res) => {
  res.json({ checkin_radius_meters: await getCheckinRadiusMeters() });
});

settingsRouter.patch("/", requireAdmin, async (req, res) => {
  const meters = Number(req.body?.checkin_radius_meters);
  if (!Number.isFinite(meters) || meters < 10 || meters > 5000) {
    return res.status(400).json({ error: "checkin_radius_meters must be between 10 and 5000" });
  }
  res.json({ checkin_radius_meters: await setCheckinRadiusMeters(Math.round(meters)) });
});
