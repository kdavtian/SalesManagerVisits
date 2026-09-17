// Periodic driver for the Bonuses challenge engine -- same setInterval-in-
// the-one-process pattern as dailySummary.js/erpSyncMonitor.js/
// bonusReconciliation.js. Each tick:
//   1. Ensures the current round exists for every published template
//      (recurring templates: the current period; 'once' templates: their
//      single round, per first_round_policy).
//   2. Processes every active round (see processRound below): recomputes
//      progress, issues watermelon awards, and finalizes it once its
//      validation_deadline_at has passed.
// No-ops entirely while app_settings.bonuses_enabled is false, same as
// bonusReconciliation.js.
import { pool } from "./db/pool.js";
import { getBonusesEnabled } from "./bonusSettings.js";
import { ensureCurrentRound, ensureOnceRound, listActiveRounds } from "./bonusChallengeRounds.js";
import { recomputeRoundProgress } from "./bonusChallengeProgress.js";
import { syncProductSalesContributions } from "./bonusProductContributions.js";
import { issueWatermelonAward } from "./bonusChallengeAwards.js";
import { createClaimsForFinalizedRound } from "./bonusRewardClaims.js";
import { updatePersonalBestsForWeek, lastCompletedWeekBounds } from "./bonusPersonalBests.js";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly, same cadence as the other Bonuses/summary workers

// Recomputes progress for one round, issues any watermelon awards it
// triggers, and finalizes it (locks in 'not_achieved', ends the round,
// creates reward claims) once its validation_deadline_at has passed.
// Exported on its own -- not just inlined in the tick loop -- so tests that
// only need "this one round, finalized" as a fixture can call it directly
// instead of runChallengeEngineTick's full sweep, which scans every
// published template/active round in the database and is therefore unsafe
// to call from a test file when others may be running concurrently against
// the same shared test database (a real flake this shape caused during
// development: one file's cleanup racing another file's global tick).
export async function processRound(round, now = new Date()) {
  if (round.snapshot_rules.type === "product_sales") await syncProductSalesContributions(round);
  const progressRows = await recomputeRoundProgress(round);

  let awardsIssued = 0;
  for (const progress of progressRows) {
    if (progress.overall_status !== "target_reached") continue;
    const { alreadyExisted } = await issueWatermelonAward(round, progress.user_id);
    if (!alreadyExisted) awardsIssued += 1;
  }

  let finalized = false;
  let claimsCreated = 0;
  if (now >= new Date(round.validation_deadline_at)) {
    await pool.query(
      `UPDATE bonus_progress SET overall_status = 'not_achieved', updated_at = now()
       WHERE round_id = $1 AND overall_status = 'in_progress'`,
      [round.id]
    );
    await pool.query("UPDATE bonus_challenge_rounds SET status = 'ended' WHERE id = $1", [round.id]);
    finalized = true;
    const { created } = await createClaimsForFinalizedRound(round);
    claimsCreated = created;
  }

  return { awardsIssued, finalized, claimsCreated };
}

export async function runChallengeEngineTick(now = new Date()) {
  if (!(await getBonusesEnabled()))
    return { roundsCreated: 0, roundsRecomputed: 0, awardsIssued: 0, roundsFinalized: 0, claimsCreated: 0 };

  const { rows: templates } = await pool.query("SELECT * FROM bonus_challenge_templates WHERE status = 'published'");
  let roundsCreated = 0;
  for (const template of templates) {
    // One template's round creation failing (e.g. a foreign-key violation
    // if the template row was deleted between the SELECT above and this
    // template's own turn in the loop -- only possible via a direct DB
    // delete, since bonusChallengeTemplates.js never exposes one past
    // draft, but real enough under concurrent test suites) must not abort
    // the sweep for every other published template still waiting in this
    // same tick.
    try {
      const { created } = template.recurrence === "once" ? await ensureOnceRound(template, now) : await ensureCurrentRound(template, now);
      if (created) roundsCreated += 1;
    } catch (err) {
      console.error(`runChallengeEngineTick: failed to ensure a round for template ${template.id}:`, err.message);
    }
  }

  const activeRounds = await listActiveRounds();
  let roundsRecomputed = 0;
  let awardsIssued = 0;
  let roundsFinalized = 0;
  let claimsCreated = 0;
  for (const round of activeRounds) {
    // Same reasoning as the round-creation loop above -- one round's
    // processing failing must not stop every other active round from
    // being recomputed/finalized in this tick.
    try {
      const result = await processRound(round, now);
      roundsRecomputed += 1;
      awardsIssued += result.awardsIssued;
      if (result.finalized) roundsFinalized += 1;
      claimsCreated += result.claimsCreated;
    } catch (err) {
      console.error(`runChallengeEngineTick: failed to process round ${round.id}:`, err.message);
    }
  }

  const lastWeek = lastCompletedWeekBounds(now);
  await updatePersonalBestsForWeek(lastWeek.startAt, lastWeek.endAt);

  return { roundsCreated, roundsRecomputed, awardsIssued, roundsFinalized, claimsCreated };
}

let started = false;
export function startBonusChallengeEngine() {
  if (started) return;
  started = true;
  setInterval(() => {
    runChallengeEngineTick().catch((err) => console.error("Bonus challenge engine tick failed:", err.message));
  }, CHECK_INTERVAL_MS);
}
