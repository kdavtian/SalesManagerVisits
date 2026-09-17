// Rule-version lookup for the always-on earning activities (strawberry,
// carrot, apple, cherry) -- see migrations/076_bonuses_schema.sql's
// bonus_earning_rule_versions table and docs/bonuses-design.md
// section 3: "Rule changes take effect prospectively at a recorded
// effective timestamp... never multiply historical quantities by today's
// rate."
import { pool } from "./db/pool.js";

export const EARNING_ACTIVITIES = ["strawberry", "carrot", "apple", "cherry"];

// The rule in force for `activity` at instant `at` (defaults to now) -- the
// latest version with effective_at <= at. Every award-time calculation
// must call this (and store the returned row's id as the ledger entry's
// rule_version_id) rather than reading "the current settings" implicitly,
// so a rule changed after the fact never silently reaches back into an
// already-awarded entry.
export async function getEarningRuleAt(activity, at = new Date()) {
  if (!EARNING_ACTIVITIES.includes(activity)) {
    throw new Error(`getEarningRuleAt: unknown activity "${activity}"`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM bonus_earning_rule_versions
     WHERE activity = $1 AND effective_at <= $2
     ORDER BY effective_at DESC
     LIMIT 1`,
    [activity, at]
  );
  return rows[0] ?? null;
}

// The four activities' current rules in one round trip -- what an admin
// settings screen and a fresh-round snapshot both need.
export async function getCurrentEarningRules(at = new Date()) {
  const rules = await Promise.all(EARNING_ACTIVITIES.map((activity) => getEarningRuleAt(activity, at)));
  return Object.fromEntries(EARNING_ACTIVITIES.map((activity, i) => [activity, rules[i]]));
}

// Publishes a new rule version, effective immediately (or at an explicit
// future timestamp) -- never edits or deletes a prior version, per the
// module's append-only-history convention. Returns the new row.
export async function setEarningRule(activity, { enabled, pointsPerUnit, effectiveAt = new Date(), createdBy, note } = {}) {
  if (!EARNING_ACTIVITIES.includes(activity)) {
    throw new Error(`setEarningRule: unknown activity "${activity}"`);
  }
  if (!Number.isInteger(pointsPerUnit) || pointsPerUnit <= 0) {
    throw new Error("setEarningRule: pointsPerUnit must be a positive integer");
  }
  const { rows } = await pool.query(
    `INSERT INTO bonus_earning_rule_versions (activity, enabled, points_per_unit, effective_at, created_by, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [activity, enabled !== false, pointsPerUnit, effectiveAt, createdBy ?? null, note ?? null]
  );
  return rows[0];
}
