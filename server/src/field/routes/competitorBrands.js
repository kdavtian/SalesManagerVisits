// Competitor brands of the check-in shelf (../competitorBrands.js; owner, 2026-11-19).
//   GET  /                the brands this person may pick (approved + their own waiting ones)
//   POST /                { name } -- a rep adds a brand: usable at once by them, a request card (+ push) for admin / CEO
//   POST /:id/approve     admin / CEO
//   POST /:id/deny        { reason } admin / CEO
import express, { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { brandsFor, requestBrand, decideBrand, BrandError } from "../competitorBrands.js";
import { notifyApproversOf, notifyDecisionOf } from "../../system/requests/notify.js";

export const competitorBrandsRouter = Router();
competitorBrandsRouter.use(requireAuth);
competitorBrandsRouter.use(express.json());

const failed = (res, err) => (err instanceof BrandError ? res.status(err.status).json({ error: err.message }) : null);

competitorBrandsRouter.get("/", async (req, res) => {
  res.json({ brands: await brandsFor(req.user.id) });
});

competitorBrandsRouter.post("/", async (req, res) => {
  try {
    const { brand, created } = await requestBrand(req.body?.name, req.user.id);
    if (created) await notifyApproversOf("competitor_brand", brand.id);
    res.status(created ? 201 : 200).json({ brand, created });
  } catch (err) {
    if (!failed(res, err)) throw err;
  }
});

for (const [action, approve] of [["approve", true], ["deny", false]]) {
  competitorBrandsRouter.post(`/:id/${action}`, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Bad brand" });
    try {
      const r = await decideBrand(id, req.user, approve, req.body?.reason);
      await notifyDecisionOf("competitor_brand", r.id, { deciderId: req.user.id, approved: approve, reason: approve ? null : r.decision_reason ?? req.body?.reason });
      res.json(r);
    } catch (err) {
      if (!failed(res, err)) throw err;
    }
  });
}
