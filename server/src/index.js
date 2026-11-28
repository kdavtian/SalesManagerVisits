import { app } from "./app.js";
import { startBackgroundJobs, stopBackgroundJobs } from "./jobs/index.js";
import { loadCustomPlaces } from "./customers/places.js";
import { runPricelistSeedOnce } from "./products/pricelistSeed.js";
import { loadChannelRulesAtStart } from "./shared/salesChannelRules.js";
import { useWebLimits, runLongWork, endPools } from "./db/pool.js";
import { createShutdown } from "./system/shutdown.js";

const port = process.env.PORT || 3000;
// requests get the web time limits (a query over 30 s is cancelled); jobs and the Excel sync keep the long ones (db/pool.js)
useWebLimits();
// the sales directions' rules (admin panel) are read before the first answer (kept fresh afterwards by salesChannelRules.js itself)
await runLongWork(() => loadChannelRulesAtStart());
const server = app.listen(port, () => {
  console.log(`Field Visits server listening on :${port}`);
  startBackgroundJobs(); // every background job, one scheduler (jobs/index.js)
  runLongWork(() => {
    loadCustomPlaces().catch((err) => console.error("custom places failed to load", err));
    runPricelistSeedOnce().catch((err) => console.error("Pricelist seed failed:", err.message));
  });
});

// a deploy: finish what is in progress, then exit (system/shutdown.js)
const shutdown = createShutdown({ server, stopJobs: stopBackgroundJobs, closeDb: endPools });
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
