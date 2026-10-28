// Every background job of the server, in one list (docs/architecture-roadmap.md, step 4). Each keeps the cadence its module had when it
// started its own setInterval; the work itself stays in its module. index.js starts them; Settings > System health shows how they ran.
import { createScheduler, jobStatus } from "./scheduler.js";
import { enabled as pushEnabled } from "../shared/push.js";
import { runReconciliationSweep } from "../bonus/bonusReconciliation.js";
import { runChallengeEngineTick } from "../bonus/bonusChallengeWorker.js";
import { checkOverdueReminders } from "../field/overdueReminders.js";
import { runOpsJobs } from "../reports/opsJobs.js";
import { runCashSheetJobs } from "../money/cashSheets.js";
import { checkDailySummary } from "../reports/dailySummary.js";
import { checkErpSyncFreshness, checkWorkbookAge } from "../erp/erpSyncMonitor.js";
import { sendDeadlineReminders, runAutoTasksOnceADay } from "../team/taskReminders.js";
import { sendWeeklyScorecards } from "../reports/scorecard.js";
import { sendWeeklyDebtDigest } from "../money/debtDigest.js";
import { checkStalePackedOrders } from "../orders/stalePackedReminder.js";
import { tick as vaghinakTick, wrapUp as vaghinakWrapUp } from "../team/vaghinak/engine.js";
import { weeklyDigest as vaghinakWeeklyDigest } from "../team/vaghinak/digest.js";
import { runAntiFraud } from "../money/antiFraud.js";
import { runExpenseWatch } from "../money/expenseWatch.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const needsPush = { enabled: () => pushEnabled, why: "push notifications are not set up (VAPID keys)" };

export const JOBS = [
  { name: "vaghinak-tick", everyMs: MINUTE, run: (now) => vaghinakTick(now) },
  { name: "vaghinak-wrap-up", everyMs: MINUTE, run: (now) => vaghinakWrapUp(now) },
  { name: "vaghinak-weekly-digest", everyMs: MINUTE, run: (now) => vaghinakWeeklyDigest(now) },
  { name: "task-deadline-reminders", everyMs: MINUTE, run: () => sendDeadlineReminders() },
  { name: "weekly-scorecard", everyMs: MINUTE, run: (now) => sendWeeklyScorecards(now) },
  { name: "weekly-debt-digest", everyMs: MINUTE, run: (now) => sendWeeklyDebtDigest(now) },
  { name: "auto-tasks", everyMs: MINUTE, run: (now) => runAutoTasksOnceADay(now) },
  { name: "daily-summary", everyMs: 5 * MINUTE, run: () => checkDailySummary(), ...needsPush },
  { name: "ops-control", everyMs: 30 * MINUTE, run: () => runOpsJobs() },
  { name: "cash-sheets", everyMs: 30 * MINUTE, run: () => runCashSheetJobs() },
  { name: "stale-packed-orders", everyMs: 30 * MINUTE, run: () => checkStalePackedOrders(), ...needsPush },
  { name: "erp-sync-freshness", everyMs: HOUR, run: () => checkErpSyncFreshness(), ...needsPush },
  { name: "excel-file-age", everyMs: HOUR, run: () => checkWorkbookAge(), ...needsPush },
  { name: "bonus-reconciliation", everyMs: HOUR, run: () => runReconciliationSweep() },
  { name: "bonus-challenges", everyMs: HOUR, run: () => runChallengeEngineTick() },
  { name: "anti-fraud", everyMs: HOUR, run: () => runAntiFraud() },
  { name: "expense-watch", everyMs: HOUR, run: () => runExpenseWatch() },
  { name: "overdue-visit-reminders", everyMs: 2 * HOUR, run: () => checkOverdueReminders(), ...needsPush },
];

let scheduler = null;
export function startBackgroundJobs() {
  scheduler ??= createScheduler(JOBS);
  scheduler.start();
}

export const backgroundJobStatus = () => jobStatus(JOBS);
