// Reward claim review/payout API (docs/bonuses-design.md, Phase 5). Listing
// is scoped by role: canApproveBonusRewards or canRecordBonusPayouts sees
// everything (or a status-filtered slice); everyone else sees only their
// own claims. Every mutation requires the caller's `version` (optimistic
// lock, same convention as perf_plans/teamPerformance.js) and surfaces a
// conflict as 409, not 500.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { canApproveBonusRewards, canRecordBonusPayouts } from "../roles.js";
import { listClaims, getClaim, approveClaim, rejectClaim, holdClaim, recordPayout, adjustClaimAmount, ClaimConflictError } from "../bonusRewardClaims.js";

export const bonusRewardClaimsRouter = Router();
bonusRewardClaimsRouter.use(requireAuth);

function canReviewClaims(role) {
  return canApproveBonusRewards(role) || canRecordBonusPayouts(role);
}

bonusRewardClaimsRouter.get("/", async (req, res) => {
  const isReviewer = canReviewClaims(req.user.role);
  const claims = await listClaims({
    status: req.query.status,
    userId: isReviewer ? req.query.user_id : req.user.id,
  });
  res.json(claims);
});

bonusRewardClaimsRouter.get("/:id", async (req, res) => {
  const claim = await getClaim(Number(req.params.id));
  if (!claim) return res.status(404).json({ error: "Not found" });
  if (claim.user_id !== req.user.id && !canReviewClaims(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  res.json(claim);
});

async function handleMutation(req, res, mutate) {
  try {
    const result = await mutate();
    res.json(result);
  } catch (err) {
    if (err instanceof ClaimConflictError) return res.status(409).json({ error: err.message });
    res.status(400).json({ error: err.message });
  }
}

bonusRewardClaimsRouter.post("/:id/approve", (req, res) =>
  handleMutation(req, res, () => approveClaim(Number(req.params.id), req.user.role, req.user.id, req.body?.expected_version))
);

bonusRewardClaimsRouter.post("/:id/reject", (req, res) =>
  handleMutation(req, res, () => rejectClaim(Number(req.params.id), req.user.role, req.user.id, req.body?.reason, req.body?.expected_version))
);

bonusRewardClaimsRouter.post("/:id/hold", (req, res) =>
  handleMutation(req, res, () => holdClaim(Number(req.params.id), req.user.role, req.user.id, req.body?.reason, req.body?.expected_version))
);

bonusRewardClaimsRouter.post("/:id/pay", (req, res) =>
  handleMutation(req, res, () => recordPayout(Number(req.params.id), req.user.role, req.user.id, req.body?.payment_reference, req.body?.expected_version))
);

bonusRewardClaimsRouter.patch("/:id/amount", (req, res) =>
  handleMutation(req, res, () =>
    adjustClaimAmount(Number(req.params.id), req.user.role, req.user.id, Number(req.body?.amount_amd), req.body?.reason, req.body?.expected_version)
  )
);
