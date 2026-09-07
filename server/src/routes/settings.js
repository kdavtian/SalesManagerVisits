import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
  getCheckinRadiusMeters,
  setCheckinRadiusMeters,
  getDefaultVisitFrequencyDays,
  setDefaultVisitFrequencyDays,
  getIncentiveMessage,
  setIncentiveMessage,
  getQuickActionVisibility,
  setQuickActionVisibility,
} from "../settings.js";
import { ROLES } from "../roles.js";

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

settingsRouter.get("/", async (req, res) => {
  const [checkinRadiusMeters, defaultVisitFrequencyDays, incentiveMessage, quickActionVisibility] =
    await Promise.all([
      getCheckinRadiusMeters(),
      getDefaultVisitFrequencyDays(),
      getIncentiveMessage(),
      getQuickActionVisibility(),
    ]);
  res.json({
    checkin_radius_meters: checkinRadiusMeters,
    default_visit_frequency_days: defaultVisitFrequencyDays,
    incentive_message: incentiveMessage,
    // Read by every role (the dashboard needs its own row to decide which
    // tiles to render); only an admin can PATCH it, same as every other
    // app_settings field here.
    quick_action_visibility: quickActionVisibility,
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

  if (req.body?.quick_action_visibility !== undefined) {
    const value = req.body.quick_action_visibility;
    // null clears every override and puts all roles back on the built-in
    // defaults -- the "reset" path, same idea as an empty incentive_message.
    if (value === null) {
      result.quick_action_visibility = await setQuickActionVisibility(null);
    } else {
      if (typeof value !== "object" || Array.isArray(value)) {
        return res.status(400).json({ error: "quick_action_visibility must be an object or null" });
      }
      const cleaned = {};
      for (const [role, ids] of Object.entries(value)) {
        if (!ROLES.includes(role)) {
          return res.status(400).json({ error: `Unknown role: ${role}` });
        }
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
          return res.status(400).json({ error: `quick_action_visibility.${role} must be an array of ids` });
        }
        cleaned[role] = [...new Set(ids)];
      }
      result.quick_action_visibility = await setQuickActionVisibility(cleaned);
    }
  }

  res.json(result);
});
