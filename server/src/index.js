import { app } from "./app.js";
import { startOverdueReminders } from "./overdueReminders.js";
import { startTaskReminders } from "./taskReminders.js";
import { startStalePackedReminder } from "./stalePackedReminder.js";
import { startErpSyncMonitor } from "./erpSyncMonitor.js";
import { startDailySummary } from "./dailySummary.js";
import { startBonusReconciliation } from "./bonusReconciliation.js";
import { startBonusChallengeEngine } from "./bonusChallengeWorker.js";
import { startVaghinak } from "./vaghinak/engine.js";
import { startOpsJobs } from "./opsJobs.js";
import { startAntiFraud } from "./antiFraud.js";
import { runPricelistSeedOnce } from "./pricelistSeed.js";

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Field Visits server listening on :${port}`);
  startOverdueReminders();
  startTaskReminders();
  startStalePackedReminder();
  startErpSyncMonitor();
  startDailySummary();
  startBonusReconciliation();
  startBonusChallengeEngine();
  startVaghinak();
  startOpsJobs();
  startAntiFraud();
  runPricelistSeedOnce().catch((err) => console.error("Pricelist seed failed:", err.message));
});
