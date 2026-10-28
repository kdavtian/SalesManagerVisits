// The one canonical implementation of every Team Performance derived
// number (pace status, forecast, required daily rate) -- reused by the
// company-wide dashboard and the personal "my performance" view alike, so
// there is exactly one place these formulas can be wrong, not two that
// quietly drift apart.
//
// Pace status compares actual attainment to *expected* attainment given
// how much of the month's working days have elapsed, not to the raw
// monthly percentage -- being at 40% sales on day 10 of 22 working days is
// on pace, not "behind". Thresholds are industry-standard attainment-pacing
// bands (not hardcoded through the UI -- see STATUS below), configurable
// here in one place if the business wants to tune them later.
export const STATUS = {
  EXCELLENT: "excellent",
  ON_TRACK: "on_track",
  SLIGHTLY_BEHIND: "slightly_behind",
  AT_RISK: "at_risk",
};

const THRESHOLDS = { excellent: 1.1, on_track: 0.95, slightly_behind: 0.85 };

// actual/target vs elapsed/total, expressed as a ratio of "how far ahead
// or behind expected pace" -- 1.0 means exactly on pace.
export function paceStatus({ actual, target, elapsedWorkingDays, totalWorkingDays }) {
  if (!target || !totalWorkingDays || !elapsedWorkingDays) return null;
  const expectedPace = elapsedWorkingDays / totalWorkingDays;
  const actualPace = actual / target;
  const ratio = actualPace / expectedPace;
  if (ratio >= THRESHOLDS.excellent) return STATUS.EXCELLENT;
  if (ratio >= THRESHOLDS.on_track) return STATUS.ON_TRACK;
  if (ratio >= THRESHOLDS.slightly_behind) return STATUS.SLIGHTLY_BEHIND;
  return STATUS.AT_RISK;
}

// Simple deterministic run-rate projection: actual / elapsed * total.
// Deliberately withheld for the first couple of working days of a month --
// a projection from 1 day of data is noise, not a forecast (per spec:
// "avoid unreliable projections in first few days").
export function forecastResult({ actual, elapsedWorkingDays, totalWorkingDays }) {
  if (elapsedWorkingDays < 3 || !totalWorkingDays) return null;
  return (actual / elapsedWorkingDays) * totalWorkingDays;
}

// What's needed per remaining working day to still hit target -- the
// single most useful number on an employee's own dashboard.
export function requiredDailyRate({ actual, target, remainingWorkingDays }) {
  const remaining = Math.max(target - actual, 0);
  if (remaining === 0) return 0;
  if (remainingWorkingDays <= 0) return null; // target is no longer reachable this month
  return remaining / remainingWorkingDays;
}

// Bundles the four numbers above for one KPI (actual vs target) into the
// shape every dashboard row needs, so call sites don't each re-derive it.
export function kpiProgress({ actual, target, elapsedWorkingDays, totalWorkingDays, remainingWorkingDays }) {
  return {
    actual,
    target,
    achievement_pct: target ? actual / target : null,
    status: paceStatus({ actual, target, elapsedWorkingDays, totalWorkingDays }),
    forecast: forecastResult({ actual, elapsedWorkingDays, totalWorkingDays }),
    required_daily_rate: requiredDailyRate({ actual, target, remainingWorkingDays }),
  };
}
