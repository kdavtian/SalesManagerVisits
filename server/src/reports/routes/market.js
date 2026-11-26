// The Market reports (owner, 2026-11-26): what reps record at check-ins (shelf, competitor prices) turned into numbers management acts
// on. The rules are in reports/market/, the SQL in its loaders; this file only checks access and answers.
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { canAccessReport } from "../reports.js";
import { marketQuality } from "../market/marketPrices.js";
import { priceIndex } from "../market/priceIndex.js";

export const marketRouter = Router();
marketRouter.use(requireAuth);

const requireReport = (key) => async (req, res, next) => ((await canAccessReport(req.user.role, key)) ? next() : res.status(403).json({ error: "Not allowed" }));

// GET /api/market/quality?days=30|90|365 -> each rep's market data score, the totals and the flagged price entries of the period
marketRouter.get("/quality", requireReport("market_quality"), async (req, res) => {
  const days = { 30: 30, 90: 90, 365: 365 }[req.query.days] ?? 30;
  res.json(await marketQuality({ days }));
});

// GET /api/market/prices -> per line and volume: competitor medians (90 days, clean), our Castrol tiers, gaps, margins, 6-month trend, drops
marketRouter.get("/prices", requireReport("market_prices"), async (req, res) => {
  res.json(await priceIndex());
});
