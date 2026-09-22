// Employee-facing Bonuses summary (docs/bonuses-design.md, Phase 6): one
// read-only aggregation for "my points, my level, my active challenges, my
// reward claims" -- the data behind the new employee screen. Nothing here
// writes anything; it only reads bonus_point_ledger, bonus_progress, and
// bonus_reward_claims, which are already maintained by the earlier phases'
// ingest/worker code.
import { pool } from "./db/pool.js";
import { fromScaled } from "./bonusUnits.js";
import { listBadgesForUser } from "./bonusBadges.js";
import { listPersonalBestsForUser } from "./bonusPersonalBests.js";

const COLLECTIBLE_ACTIVITIES = ["strawberry", "carrot", "apple", "cherry", "watermelon"];

// The level in force "now" for each threshold row is the latest version
// with effective_at <= now, per level_number -- same versioned-lookup shape
// as bonusRules.js's getEarningRuleAt, since bonus_level_thresholds is
// append-only for the same reason (076_bonuses_schema.sql).
async function getCurrentLevelThresholds(at = new Date()) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (level_number) level_number, min_points_scaled, label_key
     FROM bonus_level_thresholds
     WHERE effective_at <= $1
     ORDER BY level_number, effective_at DESC`,
    [at]
  );
  return rows.sort((a, b) => a.level_number - b.level_number);
}

function levelForPoints(thresholds, pointsScaled) {
  let current = thresholds[0] ?? null;
  let next = null;
  for (const t of thresholds) {
    if (t.min_points_scaled <= pointsScaled) current = t;
    else {
      next = t;
      break;
    }
  }
  return {
    number: current?.level_number ?? 1,
    labelKey: current?.label_key ?? null,
    nextLevelLabelKey: next?.label_key ?? null,
    pointsToNextLevel: next ? fromScaled(next.min_points_scaled - pointsScaled) : null,
  };
}

export async function getBonusSummaryForUser(userId) {
  const { rows: ledgerRows } = await pool.query(
    "SELECT activity, SUM(collectible_delta_scaled) AS collectible_total, SUM(points_delta_scaled) AS points_total FROM bonus_point_ledger WHERE user_id = $1 GROUP BY activity",
    [userId]
  );
  const collectibleCounts = Object.fromEntries(COLLECTIBLE_ACTIVITIES.map((a) => [a, 0]));
  let pointsScaledTotal = 0;
  for (const row of ledgerRows) {
    pointsScaledTotal += Number(row.points_total);
    if (collectibleCounts[row.activity] !== undefined) {
      collectibleCounts[row.activity] = fromScaled(Math.max(0, Number(row.collectible_total)));
    }
  }
  const pointsTotal = fromScaled(Math.max(0, pointsScaledTotal));

  const thresholds = await getCurrentLevelThresholds();
  const level = levelForPoints(thresholds, Math.max(0, pointsScaledTotal));

  const { rows: activeChallenges } = await pool.query(
    `SELECT r.id AS round_id, r.template_id, r.start_at, r.end_at, r.validation_deadline_at, r.snapshot_rules,
            t.title, p.component_progress, p.overall_status
     FROM bonus_round_participants rp
     JOIN bonus_challenge_rounds r ON r.id = rp.round_id
     JOIN bonus_challenge_templates t ON t.id = r.template_id
     LEFT JOIN bonus_progress p ON p.round_id = r.id AND p.user_id = rp.user_id
     WHERE rp.user_id = $1 AND r.status = 'active'
     ORDER BY r.end_at ASC`,
    [userId]
  );

  const { rows: claims } = await pool.query(
    "SELECT id, round_id, amount_amd, status, created_at, approved_at, paid_at, payment_reference FROM bonus_reward_claims WHERE user_id = $1 ORDER BY created_at DESC",
    [userId]
  );

  const badges = await listBadgesForUser(userId);
  const personalBestsRaw = await listPersonalBestsForUser(userId);
  const personalBests = Object.fromEntries(
    personalBestsRaw.map((b) => [b.metric, { value: fromScaled(b.best_value_scaled), achievedWeekStart: b.achieved_week_start }])
  );

  const pointsLeaderboard = await getBonusPointsLeaderboard();

  return { pointsTotal, collectibleCounts, level, activeChallenges, claims, badges, personalBests, pointsLeaderboard };
}

// Standings for the Bonuses page's own leaderboard -- a separate ranking
// from the Dashboard's legacy "Monthly Leaders" board (visit/photo/new-
// customer activity points, server/src/routes/dashboard.js), which is a
// different competition entirely. This one ranks by the same
// bonus_point_ledger total the employee summary above computes for "my
// points", so the two numbers a sales manager sees (their own total, and
// where that total ranks) always agree. Same "sales managers only compete,
// everyone else can watch" convention as the legacy board, and returns
// every sales manager (not just a top slice) so the client can show a top-N
// list plus the viewer's own row the same way dashboard.js already does.
async function getBonusPointsLeaderboard() {
  const { rows } = await pool.query(
    `SELECT u.id AS user_id, u.name AS user_name, COALESCE(SUM(l.points_delta_scaled), 0) AS total_points_scaled
     FROM users u
     LEFT JOIN bonus_point_ledger l ON l.user_id = u.id
     WHERE u.role = 'sales_manager'
     GROUP BY u.id, u.name
     ORDER BY total_points_scaled DESC, u.name ASC`
  );
  return rows.map((r) => ({ user_id: r.user_id, user_name: r.user_name, total_points: fromScaled(Math.max(0, Number(r.total_points_scaled))) }));
}
