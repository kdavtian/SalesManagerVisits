// Vaghinak's tunable thresholds (management edits them on his page; see .claude/skills/KADDev/references/vaghinak-spec.md).
// Minutes are minutes of the Yerevan day (570 = 09:30). mode: "off" = silent, "shadow" = he works but only management
// sees what he WOULD say (test mode), "live" = reps and everybody else get his messages.
import { pool } from "../../db/pool.js";

export const DEFAULTS = {
  mode: "shadow",
  workStartMin: 9 * 60 + 30,
  workEndMin: 17 * 60 + 30,
  lateGraceMin: 30, // up to this late = he stays quiet (but logs it)
  notStartedAskMin: 60, // no check-in yet this long after the start -> asks
  notStartedMandatoryMin: 120,
  officeWarnMin: 120, // at the office this long with visits still planned -> reminds
  officeAskMin: 165, // ... and still there -> mandatory question
  idleWarnMin: 75, // field visits started, then no check-in this long with visits left -> reminds
  idleAskMin: 150, // ... -> mandatory question
  clusterRadiusM: 300, // planned customers this close to a place the rep visited count as "next door"
  clusterFarM: 1000, // ... and the rep counts as gone once his latest visit is farther than this from them
  dailyCap: 6, // max non-mandatory messages per person per day
  // Order flow SLAs in HOURS (Operations control, order waiting too long at a step): management chases after this
  slaConfirmH: 4, // submitted -> confirmed
  slaPackH: 24, // confirmed -> packed
  slaDeliverH: 48, // packed -> delivered
  // Sales Expert funnel (funnel.js): product groups a customer must buy for stage 3, per tier; our share of its monthly need for
  // stage 4 (%); the sales window in days
  funnelGroupsBronze: 2,
  funnelGroupsSilver: 4,
  funnelGroupsGold: 6,
  funnelSharePct: 60,
  funnelWindowDays: 90,
  // the weekly next steps (nextSteps.js): "shadow" = only management sees them, "live" = each rep also gets them as tasks
  salesStepsMode: "shadow",
  // the weekly AI market strategy (strategist.js): "shadow" = written for management only, "off" = not written (no AI cost)
  strategistMode: "shadow",
  // the strategy's talking points shown to each sales manager at the check-in of a picked customer (owner, 2026-11-16: "off" until the
  // owner switches it on, after a week of reading them)
  strategyRepPoints: "off",
};

const NUMERIC = Object.keys(DEFAULTS).filter((k) => !["mode", "salesStepsMode", "strategistMode", "strategyRepPoints"].includes(k));
// the funnel's numbers have their own ranges (7 product groups exist; a share is a percent; the window is a week to a year)
const FUNNEL_RANGES = {
  funnelGroupsBronze: [1, 7, "Bronze product groups"],
  funnelGroupsSilver: [1, 7, "Silver product groups"],
  funnelGroupsGold: [1, 7, "Gold product groups"],
  funnelSharePct: [1, 100, "Our share"],
  funnelWindowDays: [7, 365, "The sales window (days)"],
};

export async function getVaghinakSettings(db = pool) {
  const { rows } = await db.query("SELECT key, value FROM vaghinak_settings");
  const out = { ...DEFAULTS };
  for (const { key, value } of rows) if (key in DEFAULTS) out[key] = value;
  return out;
}

// Returns the cleaned values that were saved; throws a 400-style error message for bad input.
export async function saveVaghinakSettings(patch, db = pool) {
  const clean = {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (key === "mode") {
      if (!["off", "shadow", "live"].includes(value)) throw new Error("mode must be off, shadow or live");
      clean.mode = value;
    } else if (key === "strategyRepPoints") {
      if (!["off", "on"].includes(value)) throw new Error("strategyRepPoints must be off or on");
      clean.strategyRepPoints = value;
    } else if (key === "strategistMode") {
      if (!["off", "shadow"].includes(value)) throw new Error("strategistMode must be off or shadow");
      clean.strategistMode = value;
    } else if (key === "salesStepsMode") {
      if (!["shadow", "live"].includes(value)) throw new Error("salesStepsMode must be shadow or live");
      clean.salesStepsMode = value;
    } else if (key in FUNNEL_RANGES) {
      const n = Number(value);
      const [min, max, what] = FUNNEL_RANGES[key];
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${what} must be a whole number from ${min} to ${max}`);
      clean[key] = n;
    } else if (NUMERIC.includes(key)) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 24 * 60) throw new Error(`${key} must be a whole number of minutes`);
      clean[key] = n;
    }
  }
  for (const [key, value] of Object.entries(clean)) {
    await db.query(
      `INSERT INTO vaghinak_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
  }
  return clean;
}
