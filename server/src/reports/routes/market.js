// The Market reports (owner, 2026-11-26): what reps record at check-ins (shelf, competitor prices) turned into numbers management acts
// on. The rules are in reports/market/, the SQL in its loaders; this file only checks access and answers.
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { canAccessReport } from "../reports.js";
import { marketQuality } from "../market/marketPrices.js";
import { priceIndex } from "../market/priceIndex.js";
import { shelfShare } from "../market/shelfShare.js";
import { marketGaps, createGapTasks } from "../market/gaps.js";
import { canCreateTasks, sendsRequests, seesProductMarket } from "../../shared/roles.js";
import { productMarket } from "../market/productMarket.js";

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

// GET /api/market/shelf?region=&channel= -> numeric / weighted distribution per brand, by region and channel, 6-month trend, fake / grey spots
marketRouter.get("/shelf", requireReport("market_shelf"), async (req, res) => {
  const pick = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : null);
  res.json(await shelfShare({ region: pick(req.query.region), channel: pick(req.query.channel) }));
});

const lineParam = (v) => (typeof v === "string" && /^[a-z0-9_]{1,40}$/.test(v) ? v : null);

// GET /api/market/gaps?line=pcmo_5w30 -> litres potential vs what we sell per line; shops with potential and no Castrol on a fresh shelf
marketRouter.get("/gaps", requireReport("market_gaps"), async (req, res) => {
  // a sales manager (when management gives them this report) sees only their own customers
  res.json(await marketGaps({ lineCode: lineParam(req.query.line), scopeUserId: req.user.role === "sales_manager" ? req.user.id : null }));
});

// POST /api/market/gap-tasks { customer_ids, line } -> a visit task per shop for its rep (management taps it; never automatic)
marketRouter.post("/gap-tasks", requireReport("market_gaps"), async (req, res) => {
  if (!canCreateTasks(req.user.role)) return res.status(403).json({ error: "Only management can create tasks" });
  const ids = req.body?.customer_ids;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "Choose the shops" });
  res.json(await createGapTasks({ customerIds: ids, lineCode: lineParam(req.body?.line), user: req.user, isRequest: sendsRequests(req.user.role) }));
});

// GET /api/market/product/:id -> the product card's Market section (shelf, competitor equivalents, wishes, line potential, lost sales)
marketRouter.get("/product/:id", async (req, res) => {
  if (!seesProductMarket(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: "Product not found" });
  const data = await productMarket(id, { role: req.user.role, scopeUserId: req.user.role === "sales_manager" ? req.user.id : null });
  if (!data) return res.status(404).json({ error: "Product not found" });
  res.json(data);
});
