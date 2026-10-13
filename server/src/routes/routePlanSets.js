import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { canPlanForOthers, canViewAllRoutePlans } from "../roles.js";
import {
  parseDays,
  parseFrequency,
  createAutoSet,
  snapshotLive,
  duplicateSet,
  activateSet,
  listSets,
  getSet,
  setRepDays,
  setSetFrequency,
} from "../routePlanSets.js";

// Route plan sets: several whole route plans, one of them active. Reading is for everyone who may see all route
// plans (the accountant read-only); creating, editing and switching is for the planning roles.
export const routePlanSetsRouter = Router();
routePlanSetsRouter.use(requireAuth);

const canRead = (req, res, next) => (canViewAllRoutePlans(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));
const canWrite = (req, res, next) => (canPlanForOthers(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));

const cleanName = (raw, fallback) => String(raw ?? "").trim().slice(0, 80) || fallback;
const todayLabel = () => new Date().toISOString().slice(0, 10);

function setId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return null;
  }
  return id;
}

routePlanSetsRouter.get("/", canRead, async (_req, res) => {
  res.json(await listSets());
});

// Automatic plan: every rep's own customers over the working days at one visit frequency.
// body: { name?, frequency_days (1-365), days: { "1": "full", ..., "6": "half" } }
routePlanSetsRouter.post("/auto", canWrite, async (req, res) => {
  const frequencyDays = parseFrequency(req.body?.frequency_days);
  if (!frequencyDays) return res.status(400).json({ error: "frequency_days must be between 1 and 365" });
  const days = parseDays(req.body?.days);
  if (!days.length) return res.status(400).json({ error: "Choose at least one working day" });
  const id = await createAutoSet({ name: cleanName(req.body?.name, `Auto ${frequencyDays}d ${todayLabel()}`), frequencyDays, days, createdBy: req.user.id });
  res.status(201).json(await getSet(id));
});

// Saves the plan that is live right now as a set (so it can be switched back to later).
routePlanSetsRouter.post("/snapshot", canWrite, async (req, res) => {
  const id = await snapshotLive({ name: cleanName(req.body?.name, `Current plan ${todayLabel()}`), createdBy: req.user.id });
  res.status(201).json(await getSet(id));
});

routePlanSetsRouter.get("/:id", canRead, async (req, res) => {
  const id = setId(req, res);
  if (id === null) return;
  const set = await getSet(id);
  if (!set) return res.status(404).json({ error: "Plan not found" });
  res.json(set);
});

routePlanSetsRouter.patch("/:id", canWrite, async (req, res) => {
  const id = setId(req, res);
  if (id === null) return;
  const { rows } = await pool.query("SELECT id FROM route_plan_sets WHERE id = $1", [id]);
  if (!rows[0]) return res.status(404).json({ error: "Plan not found" });
  if (req.body?.name !== undefined) {
    const name = cleanName(req.body.name, "");
    if (!name) return res.status(400).json({ error: "name is required" });
    await pool.query("UPDATE route_plan_sets SET name = $2, updated_at = now() WHERE id = $1", [id, name]);
  }
  if (req.body?.frequency_days !== undefined) {
    const days = parseFrequency(req.body.frequency_days);
    if (!days) return res.status(400).json({ error: "frequency_days must be between 1 and 365" });
    await setSetFrequency(id, days);
  }
  res.json(await getSet(id));
});

// One rep's weekdays: { days: { "1": [customer ids in visiting order], ... } }
routePlanSetsRouter.put("/:id/reps/:userId", canWrite, async (req, res) => {
  const id = setId(req, res);
  const userId = Number(req.params.userId);
  if (id === null || !Number.isInteger(userId)) return res.status(400).json({ error: "Invalid id" });
  const { rows } = await pool.query("SELECT id FROM route_plan_sets WHERE id = $1", [id]);
  if (!rows[0]) return res.status(404).json({ error: "Plan not found" });
  await setRepDays(id, userId, req.body?.days);
  res.json(await getSet(id));
});

routePlanSetsRouter.post("/:id/duplicate", canWrite, async (req, res) => {
  const id = setId(req, res);
  if (id === null) return;
  const { rows } = await pool.query("SELECT name FROM route_plan_sets WHERE id = $1", [id]);
  if (!rows[0]) return res.status(404).json({ error: "Plan not found" });
  const newId = await duplicateSet(id, cleanName(req.body?.name, `${rows[0].name} (copy)`), req.user.id);
  res.status(201).json(await getSet(newId));
});

routePlanSetsRouter.post("/:id/activate", canWrite, async (req, res) => {
  const id = setId(req, res);
  if (id === null) return;
  const ok = await activateSet(id, req.user.id, cleanName(req.body?.previous_name, `Previous plan ${todayLabel()}`));
  if (!ok) return res.status(404).json({ error: "Plan not found" });
  res.json({ sets: await listSets() });
});

routePlanSetsRouter.delete("/:id", canWrite, async (req, res) => {
  const id = setId(req, res);
  if (id === null) return;
  const { rows } = await pool.query("SELECT is_active FROM route_plan_sets WHERE id = $1", [id]);
  if (!rows[0]) return res.status(404).json({ error: "Plan not found" });
  if (rows[0].is_active) return res.status(409).json({ error: "The active plan cannot be deleted. Activate another plan first." });
  await pool.query("DELETE FROM route_plan_sets WHERE id = $1", [id]);
  res.status(204).end();
});
