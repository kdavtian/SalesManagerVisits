import { app } from "./app.js";
import { startOverdueReminders } from "./overdueReminders.js";
import { startStalePackedReminder } from "./stalePackedReminder.js";
import { startErpSyncMonitor } from "./erpSyncMonitor.js";

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Field Visits server listening on :${port}`);
  startOverdueReminders();
  startStalePackedReminder();
  startErpSyncMonitor();
});
