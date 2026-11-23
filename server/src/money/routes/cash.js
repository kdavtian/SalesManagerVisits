// GET /api/cash/overview -- the one Cash screen (money/cashOverview.js): my cash, what waits for me, and (for the people who see all
// payments) where the company's cash is right now.
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { cashOverview } from "../cashOverview.js";
import { seesPaymentsOnMoney } from "../../shared/roles.js";

export const cashRouter = Router();
cashRouter.use(requireAuth);

cashRouter.get("/overview", async (req, res) => {
  if (!seesPaymentsOnMoney(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  res.json(await cashOverview(req.user));
});
