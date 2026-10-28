// "What is waiting for you" per Administration category (owner idea, 2026-10-24): the count shown next to a category on the Settings list,
// so the work shows before a page is opened. Role-aware: a number is only computed for the roles that can act on it.
//   a-sales        = route plans waiting for approval (who can plan for others) + customer edit requests (admin)
//   a-bonuses      = reward claims waiting for validation or payout (the roles that review / pay claims)
//   a-system       = 1 when the Excel sync or the Excel file itself is stale (admin)
import { pool } from "../db/pool.js";
import { canPlanForOthers, canApproveBonusRewards, canRecordBonusPayouts } from "../shared/roles.js";
import { getSyncStatus } from "../erp/erpSyncStatus.js";

export async function buildAdminCounts(user) {
  const counts = {};
  const jobs = [];
  if (canPlanForOthers(user.role) || user.role === "admin") {
    jobs.push(
      (async () => {
        let n = 0;
        if (canPlanForOthers(user.role)) n += (await pool.query("SELECT count(*)::int AS n FROM visit_plans WHERE status = 'pending'")).rows[0].n;
        if (user.role === "admin") n += (await pool.query("SELECT count(*)::int AS n FROM customer_edit_requests WHERE status = 'pending'")).rows[0].n;
        counts["a-sales"] = n;
      })()
    );
  }
  if (canApproveBonusRewards(user.role) || canRecordBonusPayouts(user.role)) {
    jobs.push(
      (async () => {
        counts["a-bonuses"] = (await pool.query("SELECT count(*)::int AS n FROM bonus_reward_claims WHERE status IN ('awaiting_validation', 'approved')")).rows[0].n;
      })()
    );
  }
  if (user.role === "admin") {
    jobs.push(
      (async () => {
        const s = await getSyncStatus();
        counts["a-system"] = s.sync_stale || s.workbook_stale ? 1 : 0;
      })()
    );
  }
  await Promise.all(jobs);
  return counts;
}
