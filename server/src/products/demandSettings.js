// The demand model's two knobs (owner, 2026-11-03): lead time in days and service level in percent, kept in app_settings (migration 186) and
// edited by the admin in Settings. The model itself (demandModel.js) stays pure: callers read these here and pass them in.
import { pool } from "../db/pool.js";
import { MODEL } from "./demandModel.js";

export const DEMAND_LEAD_TIME_RANGE = [1, 365];
export const DEMAND_SERVICE_LEVEL_RANGE = [50, 99];

// z for a service level in percent (the number of standard deviations of safety stock). The usual levels are the textbook values; 95 % is
// the 1.65 the model has always used. Any other whole percent is the normal quantile rounded up to two decimals.
const Z_TABLE = { 90: 1.28, 95: 1.65, 97: 1.88, 98: 2.05, 99: 2.33 };
export function zForServiceLevel(pct) {
  if (Z_TABLE[pct]) return Z_TABLE[pct];
  const p = Math.min(0.97, Math.max(0.5, pct / 100));
  return Math.max(0, Math.ceil(inverseNormal(p) * 100 - 1e-9) / 100) || 0;
}

// Acklam's rational approximation of the inverse normal CDF, central region (0.5 <= p <= 0.97575; every level above that is in Z_TABLE).
function inverseNormal(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export async function getDemandSettings(db = pool) {
  const { rows } = await db.query("SELECT demand_lead_time_days, demand_service_level_pct FROM app_settings WHERE id = 1");
  const leadTimeDays = rows[0]?.demand_lead_time_days ?? MODEL.leadTimeDays;
  const serviceLevelPct = rows[0]?.demand_service_level_pct ?? 95;
  return { leadTimeDays, serviceLevelPct, serviceZ: zForServiceLevel(serviceLevelPct) };
}

export async function setDemandSettings({ leadTimeDays, serviceLevelPct }, db = pool) {
  await db.query(
    `INSERT INTO app_settings (id, demand_lead_time_days, demand_service_level_pct) VALUES (1, COALESCE($1, 45), COALESCE($2, 95))
     ON CONFLICT (id) DO UPDATE SET demand_lead_time_days = COALESCE($1, app_settings.demand_lead_time_days),
                                    demand_service_level_pct = COALESCE($2, app_settings.demand_service_level_pct)`,
    [leadTimeDays ?? null, serviceLevelPct ?? null]
  );
  return getDemandSettings(db);
}
