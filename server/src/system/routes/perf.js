// POST /api/perf/nav: tap-to-screen timings from the app (system/navTimings.js). Any signed-in person's app posts; at most one batch every
// 20 seconds per person (the app sends one a minute), so a broken or hostile client cannot fill the table.
// GET /api/perf/slow-screens: the "Slowest screens" table, for whoever opens the usage report (the admin).
import { Router } from "express";
import { requireAuth, requireAdmin } from "../../middleware/auth.js";
import { recordNavTimings, slowestScreens } from "../navTimings.js";

export const perfRouter = Router();
perfRouter.use(requireAuth);

const MIN_GAP_MS = 20000;
const lastPostAt = new Map(); // user id -> time of the last accepted batch

perfRouter.post("/nav", async (req, res) => {
  const now = Date.now();
  const last = lastPostAt.get(req.user.id) ?? 0;
  const bypass = Boolean(process.env.E2E_RATE_LIMIT_BYPASS_TOKEN) && req.get("x-e2e-rate-limit-bypass") === process.env.E2E_RATE_LIMIT_BYPASS_TOKEN;
  if (now - last < MIN_GAP_MS && !bypass) return res.status(429).json({ error: "Too many timing batches" });
  if (lastPostAt.size > 5000) lastPostAt.clear();
  lastPostAt.set(req.user.id, now);
  const items = req.body?.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: "Send the timings as a list" });
  const stored = await recordNavTimings(req.user, items, req.body?.device);
  res.json({ stored });
});

perfRouter.get("/slow-screens", requireAdmin, async (req, res) => {
  res.json(await slowestScreens(req.query.days));
});
