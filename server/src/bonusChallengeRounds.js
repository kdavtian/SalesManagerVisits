// Round generation for the Bonuses challenge engine (bonus_challenge_rounds,
// bonus_round_participants -- migrations/076_bonuses_schema.sql). Called by
// bonusChallengeWorker.js's periodic sweep: "ensure the current period's
// round exists" for every published recurring template, plus the one-time
// round for a 'once' template. UNIQUE(template_id, start_at) makes a repeat
// call for a period that already has a round a cheap no-op, so the worker
// never needs to track "did I already run this period" itself.
import { pool } from "./db/pool.js";
import { yerevanDayBounds, yerevanWeekBounds, yerevanMonthBounds, yerevanYearBounds, yerevanCustomRangeBounds } from "./utils/yerevanDate.js";
import { insertIdempotent } from "./bonusIdempotency.js";

// A DATE column (custom_start_date/custom_end_date) comes back from
// node-postgres as a JS Date at UTC midnight, not the "YYYY-MM-DD" string
// yerevanCustomRangeBounds expects -- convert explicitly rather than let a
// template-string coercion of a Date silently produce an unparseable
// instant.
function dateColumnToIsoDate(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

const BOUNDS_FOR_RECURRENCE = {
  daily: yerevanDayBounds,
  weekly: yerevanWeekBounds,
  monthly: yerevanMonthBounds,
  yearly: yerevanYearBounds,
};

// The template's rule-bearing fields, frozen at round-creation time. A
// later template edit (only possible pre-publish anyway) or a mid-round
// change to the general earning rate never reaches back into an
// already-created round's targets/audience/reward.
async function buildSnapshotRules(template) {
  const { rows: targets } = await pool.query(
    "SELECT metric, target_scaled FROM bonus_challenge_template_targets WHERE template_id = $1",
    [template.id]
  );
  const { rows: productTargets } = await pool.query(
    "SELECT id, product_id, product_name_snapshot, product_unit_snapshot, target_pieces FROM bonus_challenge_product_targets WHERE template_id = $1",
    [template.id]
  );
  return {
    type: template.type,
    targets,
    productTargets,
    audienceMode: template.audience_mode,
    audienceUserIds: template.audience_user_ids,
    audienceRoles: template.audience_roles,
    rewardAmd: template.reward_amd,
    watermelonPointValue: template.watermelon_point_value,
  };
}

async function resolveAudience(client, template) {
  if (template.audience_mode === "selected_roles") {
    const { rows } = await client.query("SELECT id FROM users WHERE role = ANY($1)", [template.audience_roles]);
    return rows.map((r) => r.id);
  }
  return template.audience_user_ids ?? [];
}

async function createRound(client, template, { startAt, endAt }) {
  const snapshotRules = await buildSnapshotRules(template);
  const validationDeadlineAt = new Date(endAt.getTime() + template.validation_grace_days * 24 * 60 * 60 * 1000);

  // UNIQUE(template_id, start_at) is what makes this period's round
  // idempotent under a retry or a concurrent scheduler -- insertIdempotent's
  // SAVEPOINT wrapping is required here (not a bare try/catch) since a plain
  // caught unique-violation would otherwise leave the enclosing transaction
  // aborted for every query after it, including the fallback SELECT below.
  const { row: round, alreadyExisted } = await insertIdempotent(client, {
    insertSql: `INSERT INTO bonus_challenge_rounds (template_id, start_at, end_at, validation_deadline_at, snapshot_rules)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    insertParams: [template.id, startAt, endAt, validationDeadlineAt, JSON.stringify(snapshotRules)],
    conflictSelectSql: "SELECT * FROM bonus_challenge_rounds WHERE template_id = $1 AND start_at = $2",
    conflictSelectParams: [template.id, startAt],
  });
  if (alreadyExisted) return { round, created: false };

  const participantIds = await resolveAudience(client, template);
  for (const userId of participantIds) {
    await client.query("INSERT INTO bonus_round_participants (round_id, user_id) VALUES ($1, $2) ON CONFLICT (round_id, user_id) DO NOTHING", [
      round.id,
      userId,
    ]);
  }
  return { round, created: true };
}

// Ensures the current period's round exists for a published recurring
// template (daily/weekly/monthly/yearly). Safe to call repeatedly -- a
// no-op once the period's round has been created.
export async function ensureCurrentRound(template, now = new Date()) {
  const boundsFn = BOUNDS_FOR_RECURRENCE[template.recurrence];
  if (!boundsFn) throw new Error(`ensureCurrentRound: template ${template.id} has recurrence '${template.recurrence}', not a recurring one`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await createRound(client, template, boundsFn(now));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Creates the single round for a 'once' template, per its first_round_policy:
// - publish_forward: starts now, ends at now + validation window is N/A here
//   (a "once, right now, indefinitely open" round would never end -- so
//   publish_forward for 'once' uses today's Yerevan day as its window,
//   matching "a one-off challenge announced and run today").
// - scheduled_future: only creates the round once `now >= scheduled_start_at`;
//   returns { round: null, created: false } before that.
// - historical_explicit: uses the template's own custom_start_date/
//   custom_end_date verbatim, regardless of `now`.
export async function ensureOnceRound(template, now = new Date()) {
  if (template.recurrence !== "once") throw new Error(`ensureOnceRound: template ${template.id} is recurring, not 'once'`);

  let bounds;
  if (template.first_round_policy === "historical_explicit") {
    if (!template.custom_start_date || !template.custom_end_date) {
      throw new Error(`ensureOnceRound: template ${template.id} is historical_explicit but has no custom date range`);
    }
    bounds = yerevanCustomRangeBounds(dateColumnToIsoDate(template.custom_start_date), dateColumnToIsoDate(template.custom_end_date));
  } else if (template.first_round_policy === "scheduled_future") {
    if (!template.scheduled_start_at || now < new Date(template.scheduled_start_at)) return { round: null, created: false };
    bounds = yerevanDayBounds(new Date(template.scheduled_start_at));
  } else {
    bounds = yerevanDayBounds(now);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await createRound(client, template, bounds);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getRound(id) {
  const { rows } = await pool.query("SELECT * FROM bonus_challenge_rounds WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listActiveRounds() {
  const { rows } = await pool.query("SELECT * FROM bonus_challenge_rounds WHERE status = 'active' ORDER BY end_at ASC");
  return rows;
}

export async function getRoundParticipants(roundId) {
  const { rows } = await pool.query("SELECT user_id FROM bonus_round_participants WHERE round_id = $1", [roundId]);
  return rows.map((r) => r.user_id);
}
