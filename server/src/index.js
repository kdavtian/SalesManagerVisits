import { app } from "./app.js";
import { startOverdueReminders } from "./overdueReminders.js";
import { startStalePackedReminder } from "./stalePackedReminder.js";
import { startErpSyncMonitor } from "./erpSyncMonitor.js";
import { startDailySummary } from "./dailySummary.js";
import { startBonusReconciliation } from "./bonusReconciliation.js";
import { startBonusChallengeEngine } from "./bonusChallengeWorker.js";

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Field Visits server listening on :${port}`);
  startOverdueReminders();
  startStalePackedReminder();
  startErpSyncMonitor();
  startDailySummary();
  startBonusReconciliation();
  startBonusChallengeEngine();
});
