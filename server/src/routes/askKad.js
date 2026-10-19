// Ask KAD API (admin only): POST a question, get an answer built from the company's own data.
// See src/askKad/engine.js for how it works and what leaves the server (names never do).
import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { askKad, isConfigured, DEFAULT_MODEL, AskError } from "../askKad/engine.js";
import { getAskKadSettings, monthSpendUsd } from "../askKad/settings.js";

export const askKadRouter = Router();
askKadRouter.use(requireAuth, requireAdmin);

const MAX_QUESTION = 2000;
const MAX_TURN = 6000;
const inFlight = new Set(); // one question at a time per admin: a double tap must not pay twice

askKadRouter.get("/status", async (req, res) => {
  const [settings, spent] = await Promise.all([getAskKadSettings(), monthSpendUsd()]);
  res.json({
    configured: isConfigured(),
    enabled: settings.enabled,
    cap_usd: settings.capUsd,
    spent_usd: Math.round(spent * 100) / 100,
    model: process.env.ASK_KAD_MODEL || DEFAULT_MODEL,
  });
});

askKadRouter.post("/", async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!question || question.length > MAX_QUESTION) return res.status(400).json({ error: "question must be 1-2000 characters" });
  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const history = rawHistory
    .filter((h) => h && ["user", "assistant"].includes(h.role) && typeof h.text === "string" && h.text.trim())
    .map((h) => ({ role: h.role, text: h.text.slice(0, MAX_TURN) }));
  // The conversation sent to the model must start with the user and alternate.
  while (history.length && history[0].role !== "user") history.shift();
  const alternating = history.filter((h, i) => i === 0 || h.role !== history[i - 1].role);

  if (inFlight.has(req.user.id)) return res.status(429).json({ error: "busy" });
  inFlight.add(req.user.id);
  try {
    const result = await askKad({ question, history: alternating, userId: req.user.id });
    res.json(result);
  } catch (err) {
    if (err instanceof AskError) {
      if (err.code === "ai_error") console.error("Ask KAD AI error:", err.message);
      return res.status(err.status).json({ error: err.code });
    }
    throw err;
  } finally {
    inFlight.delete(req.user.id);
  }
});
