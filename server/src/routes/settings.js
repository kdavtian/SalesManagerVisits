import { Router } from "express";
import bcrypt from "bcryptjs";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import {
  getCheckinRadiusMeters,
  getCheckinAllowanceEnabled,
  setCheckinAllowanceEnabled,
  setCheckinRadiusMeters,
  getDefaultVisitFrequencyDays,
  setDefaultVisitFrequencyDays,
  getIncentiveMessage,
  setIncentiveMessage,
  getQuickActionVisibility,
  setQuickActionVisibility,
  getCalculatorPinHash,
  setCalculatorPinHash,
  getCalculatorModeEnabled,
  setCalculatorModeEnabled,
} from "../settings.js";
import { getBonusesEnabled, setBonusesEnabled } from "../bonusSettings.js";
import { getAskKadSettings, setAskKadEnabled, setAskKadMonthlyCapUsd } from "../askKad/settings.js";
import { ensureCurrentRound, ensureOnceRound } from "../bonusChallengeRounds.js";
import { ROLES } from "../roles.js";
import { pool } from "../db/pool.js";
import { getPlanSkipRecentVisitDays, setPlanSkipRecentVisitDays } from "../utils/planSkipRecent.js";

export const settingsRouter = Router();

settingsRouter.use(requireAuth);

settingsRouter.get("/", async (req, res) => {
  const [
    checkinRadiusMeters,
    checkinAllowanceEnabled,
    defaultVisitFrequencyDays,
    planSkipRecentVisitDays,
    incentiveMessage,
    quickActionVisibility,
    calculatorPinHash,
    calculatorModeEnabled,
    bonusesEnabled,
    askKad,
  ] = await Promise.all([
    getCheckinRadiusMeters(),
    getCheckinAllowanceEnabled(),
    getDefaultVisitFrequencyDays(),
    getPlanSkipRecentVisitDays(),
    getIncentiveMessage(),
    getQuickActionVisibility(),
    getCalculatorPinHash(),
    getCalculatorModeEnabled(),
    getBonusesEnabled(),
    getAskKadSettings(),
  ]);
  res.json({
    checkin_radius_meters: checkinRadiusMeters,
    checkin_allowance_enabled: checkinAllowanceEnabled,
    default_visit_frequency_days: defaultVisitFrequencyDays,
    plan_skip_recent_visit_days: planSkipRecentVisitDays,
    incentive_message: incentiveMessage,
    // Read by every role (the dashboard needs its own row to decide which
    // tiles to render); only an admin can PATCH it, same as every other
    // app_settings field here.
    quick_action_visibility: quickActionVisibility,
    // Never the actual PIN or its hash -- same write-only shape as a
    // password field. This just tells Settings whether to say "custom
    // code set" or "using the default code" next to the input.
    calculator_pin_is_custom: calculatorPinHash != null,
    calculator_mode_enabled: calculatorModeEnabled,
    // Read-only here -- the flag is only ever written via the Bonuses
    // admin work (a later step, not this settings PATCH). Every role
    // reads it: the dashboard needs it to decide whether to show the
    // Bonuses quick action/entry point at all (docs/bonuses-design.md).
    bonuses_enabled: bonusesEnabled,
    // Ask KAD (the admin's AI analyst): On/Off and the monthly spending cap in USD.
    ask_kad_enabled: askKad.enabled,
    ask_kad_monthly_cap_usd: askKad.capUsd,
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

  if (req.body?.checkin_allowance_enabled !== undefined) {
    if (typeof req.body.checkin_allowance_enabled !== "boolean") {
      return res.status(400).json({ error: "checkin_allowance_enabled must be a boolean" });
    }
    result.checkin_allowance_enabled = await setCheckinAllowanceEnabled(req.body.checkin_allowance_enabled);
  }

  if (req.body?.default_visit_frequency_days !== undefined) {
    const days = Number(req.body.default_visit_frequency_days);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return res.status(400).json({ error: "default_visit_frequency_days must be between 1 and 365" });
    }
    result.default_visit_frequency_days = await setDefaultVisitFrequencyDays(Math.round(days));
  }

  if (req.body?.plan_skip_recent_visit_days !== undefined) {
    const days = Number(req.body.plan_skip_recent_visit_days);
    if (!Number.isFinite(days) || days < 0 || days > 60) {
      return res.status(400).json({ error: "plan_skip_recent_visit_days must be between 0 and 60" });
    }
    result.plan_skip_recent_visit_days = await setPlanSkipRecentVisitDays(Math.round(days));
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

  if (req.body?.calculator_pin !== undefined) {
    const pin = req.body.calculator_pin;
    // Empty string resets to the built-in default, same "empty clears the
    // override" convention as incentive_message/quick_action_visibility
    // above -- never null itself, since the client sends a plain string.
    if (pin === "") {
      await setCalculatorPinHash(null);
      result.calculator_pin_is_custom = false;
    } else {
      if (typeof pin !== "string" || !/^\d{4,8}$/.test(pin)) {
        return res.status(400).json({ error: "calculator_pin must be 4 to 8 digits" });
      }
      await setCalculatorPinHash(await bcrypt.hash(pin, 10));
      result.calculator_pin_is_custom = true;
    }
  }

  if (req.body?.calculator_mode_enabled !== undefined) {
    if (typeof req.body.calculator_mode_enabled !== "boolean") {
      return res.status(400).json({ error: "calculator_mode_enabled must be a boolean" });
    }
    result.calculator_mode_enabled = await setCalculatorModeEnabled(req.body.calculator_mode_enabled);
  }

  if (req.body?.ask_kad_enabled !== undefined) {
    if (typeof req.body.ask_kad_enabled !== "boolean") {
      return res.status(400).json({ error: "ask_kad_enabled must be a boolean" });
    }
    result.ask_kad_enabled = await setAskKadEnabled(req.body.ask_kad_enabled);
  }

  if (req.body?.ask_kad_monthly_cap_usd !== undefined) {
    const usd = Number(req.body.ask_kad_monthly_cap_usd);
    if (!Number.isFinite(usd) || usd < 1 || usd > 5000) {
      return res.status(400).json({ error: "ask_kad_monthly_cap_usd must be between 1 and 5000" });
    }
    result.ask_kad_monthly_cap_usd = await setAskKadMonthlyCapUsd(Math.round(usd * 100) / 100);
  }

  if (req.body?.bonuses_enabled !== undefined) {
    if (typeof req.body.bonuses_enabled !== "boolean") {
      return res.status(400).json({ error: "bonuses_enabled must be a boolean" });
    }
    result.bonuses_enabled = await setBonusesEnabled(req.body.bonuses_enabled);
    // Turning the flag on shouldn't leave every already-published template
    // waiting on the next hourly bonusChallengeWorker.js tick (see
    // routes/bonusChallenges.js's own publish handler for the same fix on
    // the publish path) -- create each one's current round right away.
    if (result.bonuses_enabled) {
      const { rows: templates } = await pool.query("SELECT * FROM bonus_challenge_templates WHERE status = 'published'");
      for (const template of templates) {
        if (template.recurrence === "once") await ensureOnceRound(template);
        else await ensureCurrentRound(template);
      }
    }
  }

  res.json(result);
});
