// Periodic driver for the Bonuses challenge engine -- same setInterval-in-
// the-one-process pattern as dailySummary.js/erpSyncMonitor.js/
// bonusReconciliation.js. Each tick:
//   1. Ensures the current round exists for every published template
//      (recurring templates: the current period; 'once' templates: their
//      single round, per first_round_policy).
//   2. Recomputes progress for every active round (product-sales rounds
//      sync their order-line contributions first) and issues a watermelon
//      award the moment a participant's progress reaches target.
//   3. Finalizes any round whose validation_deadline_at has passed: locks
//      in 'not_achieved' for anyone who never reached target, and ends the
//      round so it stops being recomputed on future ticks.
// No-ops entirely while app_settings.bonuses_enabled is false, same as
// bonusReconciliation.js.
import { pool } from "./db/pool.js";
import { getBonusesEnabled } from "./bonusSettings.js";
import { ensureCurrentRound, ensureOnceRound, listActiveRounds } from "./bonusChallengeRounds.js";
import { recomputeRoundProgress } from "./bonusChallengeProgress.js";
import { syncProductSalesContributions } from "./bonusProductContributions.js";
import { issueWatermelonAward } from "./bonusChallengeAwards.js";

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly, same cadence as the other Bonuses/summary workers

export async function runChallengeEngineTick(now = new Date()) {
  if (!(await getBonusesEnabled())) return { roundsCreated: 0, roundsRecomputed: 0, awardsIssued: 0, roundsFinalized: 0 };

  const { rows: templates } = await pool.query("SELECT * FROM bonus_challenge_templates WHERE status = 'published'");
  let roundsCreated = 0;
  for (const template of templates) {
    const { created } = template.recurrence === "once" ? await ensureOnceRound(template, now) : await ensureCurrentRound(template, now);
    if (created) roundsCreated += 1;
  }

  const activeRounds = await listActiveRounds();
  let roundsRecomputed = 0;
  let awardsIssued = 0;
  let roundsFinalized = 0;
  for (const round of activeRounds) {
    if (round.snapshot_rules.type === "product_sales") await syncProductSalesContributions(round);
    const progressRows = await recomputeRoundProgress(round);
    roundsRecomputed += 1;

    for (const progress of progressRows) {
      if (progress.overall_status !== "target_reached") continue;
      const { alreadyExisted } = await issueWatermelonAward(round, progress.user_id);
      if (!alreadyExisted) awardsIssued += 1;
    }

    if (now >= new Date(round.validation_deadline_at)) {
      await pool.query(
        `UPDATE bonus_progress SET overall_status = 'not_achieved', updated_at = now()
         WHERE round_id = $1 AND overall_status = 'in_progress'`,
        [round.id]
      );
      await pool.query("UPDATE bonus_challenge_rounds SET status = 'ended' WHERE id = $1", [round.id]);
      roundsFinalized += 1;
    }
  }

  return { roundsCreated, roundsRecomputed, awardsIssued, roundsFinalized };
}

let started = false;
export function startBonusChallengeEngine() {
  if (started) return;
  started = true;
  setInterval(() => {
    runChallengeEngineTick().catch((err) => console.error("Bonus challenge engine tick failed:", err.message));
  }, CHECK_INTERVAL_MS);
}
