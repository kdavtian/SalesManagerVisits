// Employee-facing "my Bonuses" summary (docs/bonuses-design.md, Phase 6).
// Always scoped to the authenticated caller -- there is no admin/other-user
// variant here (an admin reviewing someone else's standing uses the
// existing bonus-challenges round/progress endpoints and bonus-reward-claims
// list instead).
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getBonusSummaryForUser } from "../bonusEmployeeSummary.js";
import { getBonusesEnabled } from "../bonusSettings.js";

export const bonusSummaryRouter = Router();
bonusSummaryRouter.use(requireAuth);

bonusSummaryRouter.get("/", async (req, res) => {
  if (!(await getBonusesEnabled())) return res.status(404).json({ error: "Bonuses is not enabled" });
  const summary = await getBonusSummaryForUser(req.user.id);
  res.json(summary);
});
