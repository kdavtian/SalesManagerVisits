import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
  getCheckinRadiusMeters,
  setCheckinRadiusMeters,
  getDefaultVisitFrequencyDays,
  setDefaultVisitFrequencyDays,
  getIncentiveMessage,
  setIncentiveMessage,
} from "../settings.js";

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

settingsRouter.get("/", async (req, res) => {
  const [checkinRadiusMeters, defaultVisitFrequencyDays, incentiveMessage] = await Promise.all([
    getCheckinRadiusMeters(),
    getDefaultVisitFrequencyDays(),
    getIncentiveMessage(),
  ]);
  res.json({
    checkin_radius_meters: checkinRadiusMeters,
    default_visit_frequency_days: defaultVisitFrequencyDays,
    incentive_message: incentiveMessage,
  });
});

settingsRouter.patch("/", requireAdmin, async (req, res) => {
  const result = {};

  if (req.body?.checkin_radius_meters !== undefined) {
    const meters = Number(req.body.checkin_radius_meters);
    if (!Number.isFinite(meters) || meters < 10 || meters > 5000) {
      return res.status(400).json({ error: "checkin_radius_meters must be between 10 and 5000" });
    }
    result.checkin_radius_meters = await setCheckinRadiusMeters(Math.round(meters));
  }

  if (req.body?.default_visit_frequency_days !== undefined) {
    const days = Number(req.body.default_visit_frequency_days);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return res.status(400).json({ error: "default_visit_frequency_days must be between 1 and 365" });
    }
    result.default_visit_frequency_days = await setDefaultVisitFrequencyDays(Math.round(days));
  }

  if (req.body?.incentive_message !== undefined) {
    const message = String(req.body.incentive_message).trim();
    if (message.length > 200) {
      return res.status(400).json({ error: "incentive_message must be 200 characters or fewer" });
    }
    // Empty string resets to the built-in default (stored as NULL).
    result.incentive_message = await setIncentiveMessage(message || null);
  }

  res.json(result);
});
