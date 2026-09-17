// Admin management of Bonus challenge templates and read access to their
// rounds/progress (docs/bonuses-design.md, Phase 4). Template management is
// gated to canManageBonusChallenges (admin/ceo); reading rounds/progress is
// open to any authenticated user narrowed to their own participation,
// except for admins/ceo who can see any round's full roster (matches
// canManageBonusChallenges again -- the same people who design a challenge
// are the ones who need to see how everyone is doing in it).
import { Router } from "express";
import { requireAuth, requireBonusChallengeManager } from "../middleware/auth.js";
import { createDraftTemplate, getTemplate, listTemplates, publishTemplate, cancelTemplate, updateDraftTemplate } from "../bonusChallengeTemplates.js";
import { getRound, getRoundParticipants, ensureCurrentRound, ensureOnceRound } from "../bonusChallengeRounds.js";
import { getBonusesEnabled } from "../bonusSettings.js";
import { getProgress } from "../bonusChallengeProgress.js";
import { canManageBonusChallenges } from "../roles.js";
import { pool } from "../db/pool.js";

export const bonusChallengesRouter = Router();
bonusChallengesRouter.use(requireAuth);

bonusChallengesRouter.get("/templates", requireBonusChallengeManager, async (req, res) => {
  const templates = await listTemplates({ status: req.query.status });
  res.json(templates);
});

bonusChallengesRouter.get("/templates/:id", requireBonusChallengeManager, async (req, res) => {
  const template = await getTemplate(Number(req.params.id));
  if (!template) return res.status(404).json({ error: "Not found" });
  res.json(template);
});

bonusChallengesRouter.post("/templates", requireBonusChallengeManager, async (req, res) => {
  try {
    const template = await createDraftTemplate(req.body ?? {}, req.user.id);
    res.status(201).json(template);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

bonusChallengesRouter.patch("/templates/:id", requireBonusChallengeManager, async (req, res) => {
  try {
    const template = await updateDraftTemplate(Number(req.params.id), req.body ?? {});
    res.json(template);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

bonusChallengesRouter.post("/templates/:id/publish", requireBonusChallengeManager, async (req, res) => {
  try {
    const template = await publishTemplate(Number(req.params.id), req.user.id);
    // Otherwise the first round only appears once the hourly
    // bonusChallengeWorker.js tick happens to run next (up to an hour after
    // this request, and setInterval fires no earlier than one full interval
    // after server boot -- see startBonusChallengeEngine), so an admin
    // publishing a challenge would see nothing change and a sales rep would
    // see no active challenge until then. ensureCurrentRound/ensureOnceRound
    // are the same idempotent functions the worker itself calls, so this is
    // safe to run inline here too.
    if (await getBonusesEnabled()) {
      if (template.recurrence === "once") await ensureOnceRound(template);
      else await ensureCurrentRound(template);
    }
    res.json(template);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

bonusChallengesRouter.post("/templates/:id/cancel", requireBonusChallengeManager, async (req, res) => {
  try {
    const template = await cancelTemplate(Number(req.params.id), req.user.id, req.body?.reason);
    res.json(template);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

bonusChallengesRouter.get("/rounds/:id", async (req, res) => {
  const round = await getRound(Number(req.params.id));
  if (!round) return res.status(404).json({ error: "Not found" });
  const participantIds = await getRoundParticipants(round.id);
  if (!canManageBonusChallenges(req.user.role) && !participantIds.includes(req.user.id)) {
    return res.status(403).json({ error: "Not allowed" });
  }
  res.json(round);
});

bonusChallengesRouter.get("/rounds/:id/progress", async (req, res) => {
  const round = await getRound(Number(req.params.id));
  if (!round) return res.status(404).json({ error: "Not found" });
  const participantIds = await getRoundParticipants(round.id);
  const isManager = canManageBonusChallenges(req.user.role);
  if (!isManager && !participantIds.includes(req.user.id)) {
    return res.status(403).json({ error: "Not allowed" });
  }
  if (isManager) {
    const { rows } = await pool.query(
      `SELECT p.*, u.name AS user_name FROM bonus_progress p JOIN users u ON u.id = p.user_id WHERE p.round_id = $1 ORDER BY u.name`,
      [round.id]
    );
    return res.json(rows);
  }
  const progress = await getProgress(round.id, req.user.id);
  res.json(progress ? [progress] : []);
});
