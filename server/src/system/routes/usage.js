// Usage analytics (system/usageAnalytics.js). Every signed-in person's app posts its batch here (a no-op answer while the switch is off);
// only the admin reads the report.
import { Router } from "express";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { getUsageEnabled, recordEvents, usageReport } from "../usageAnalytics.js";

export const usageRouter = Router();
usageRouter.use(requireAuth);

usageRouter.post("/events", async (req, res) => {
  if (!(await getUsageEnabled())) return res.json({ enabled: false });
  await recordEvents(req.user, req.body?.events);
  res.json({ enabled: true });
});

usageRouter.get("/report", requireAdmin, async (req, res) => {
  res.json(await usageReport(req.query.days));
});
