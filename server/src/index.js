import { app } from "./app.js";
import { startBackgroundJobs } from "./jobs/index.js";
import { loadCustomPlaces } from "./places.js";
import { runPricelistSeedOnce } from "./pricelistSeed.js";

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Field Visits server listening on :${port}`);
  startBackgroundJobs(); // every background job, one scheduler (jobs/index.js)
  loadCustomPlaces().catch((err) => console.error("custom places failed to load", err));
  runPricelistSeedOnce().catch((err) => console.error("Pricelist seed failed:", err.message));
});
