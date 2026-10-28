import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { canAccessReport } from "../reports.js";
import { erpSyncFreshness } from "../../erp/erpSyncFreshness.js";
import { buildVolumeReport } from "../volumeReport.js";

export const volumeReportRouter = Router();
volumeReportRouter.use(requireAuth);

// GET /api/volume-report?period=this_month|today|...|custom&from&to&compare=prev|yoy|none&group_by=product|family|...
//   &brands&families&grades&sizes&products&channels&tiers&region_sub&q&cq   (comma-separated lists)
volumeReportRouter.get("/", async (req, res) => {
  if (!(await canAccessReport(req.user.role, "product_liters"))) return res.status(403).json({ error: "Not allowed" });
  const report = await buildVolumeReport({
    query: req.query,
    // A sales manager sees the liters of their own customers only.
    scopeUserId: req.user.role === "sales_manager" ? req.user.id : null,
  });
  res.json({ ...report, sync: await erpSyncFreshness("erp_customer_data") });
});
