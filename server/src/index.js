import { app } from "./app.js";
import { startBackgroundJobs } from "./jobs/index.js";
import { loadCustomPlaces } from "./customers/places.js";
import { runPricelistSeedOnce } from "./products/pricelistSeed.js";
import { loadChannelRulesAtStart } from "./shared/salesChannelRules.js";

const port = process.env.PORT || 3000;
// the sales directions' rules (admin panel) are read before the first answer (kept fresh afterwards by salesChannelRules.js itself)
await loadChannelRulesAtStart();
app.listen(port, () => {
  console.log(`Field Visits server listening on :${port}`);
  startBackgroundJobs(); // every background job, one scheduler (jobs/index.js)
  loadCustomPlaces().catch((err) => console.error("custom places failed to load", err));
  runPricelistSeedOnce().catch((err) => console.error("Pricelist seed failed:", err.message));
});
