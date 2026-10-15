// Vaghinak's tunable thresholds (management edits them on his page; see .claude/skills/KADDev/references/vaghinak-spec.md).
// Minutes are minutes of the Yerevan day (570 = 09:30). mode: "off" = silent, "shadow" = he works but only management
// sees what he WOULD say (test mode), "live" = reps and everybody else get his messages.
import { pool } from "../db/pool.js";

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
};

const NUMERIC = Object.keys(DEFAULTS).filter((k) => k !== "mode");

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
