// Vaghinak (Վաղինակ) API. Everybody: own inbox, badge, the blocking question, answering, reacting.
// Management (admin, CEO, operations/sales director, accountant): Team pulse, the questions-and-answers log, the full
// feed (including what he WOULD say in shadow mode). Settings and addressing: admin / CEO / operations director.
import { Router } from "express";
import { autoTaskDiagnostics } from "../../money/debtCollectionTasks.js";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { MANAGEMENT_ROLES, tick, wrapUp, teamPulse } from "../vaghinak/engine.js";
import { getVaghinakSettings, saveVaghinakSettings } from "../vaghinak/settings.js";
import { yerevanToday } from "../../utils/yerevanDate.js";
import { editsVaghinakSettings } from "../../shared/roles.js";

export const vaghinakRouter = Router();
vaghinakRouter.use(requireAuth);

const requireManagement = (req, res, next) => (MANAGEMENT_ROLES.includes(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));
const requireSettingsRole = (req, res, next) => (editsVaghinakSettings(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));

const MINE = "user_id = $1 AND NOT shadow";
const SELECT_MESSAGE = `id, kind, day, level, severity, body, needs_answer, mandatory, choices, answer_choice, answer_text, answered_at, read_at, reaction, created_at`;

// What the Home tile badge counts: unread messages + questions still waiting for an answer.
async function badgeCount(userId) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM vaghinak_messages WHERE ${MINE} AND (read_at IS NULL OR (needs_answer AND answered_at IS NULL))`,
    [userId]
  );
  return rows[0].n;
}

vaghinakRouter.get("/badge", async (req, res) => res.json({ count: await badgeCount(req.user.id) }));

// The question the person must answer before doing anything else (null when there is none).
vaghinakRouter.get("/pending", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${SELECT_MESSAGE} FROM vaghinak_messages WHERE ${MINE} AND mandatory AND answered_at IS NULL ORDER BY created_at LIMIT 1`,
    [req.user.id]
  );
  res.json(rows[0] ?? null);
});

vaghinakRouter.get("/inbox", async (req, res) => {
  const { rows } = await pool.query(`SELECT ${SELECT_MESSAGE} FROM vaghinak_messages WHERE ${MINE} ORDER BY created_at DESC LIMIT 60`, [req.user.id]);
  res.json({ messages: rows, badge: await badgeCount(req.user.id) });
});

vaghinakRouter.post("/messages/read-all", async (req, res) => {
  await pool.query(`UPDATE vaghinak_messages SET read_at = now() WHERE ${MINE} AND read_at IS NULL AND NOT needs_answer`, [req.user.id]);
  res.json({ count: await badgeCount(req.user.id) });
});

vaghinakRouter.post("/messages/:id/read", async (req, res) => {
  await pool.query("UPDATE vaghinak_messages SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND user_id = $2 AND NOT shadow", [Number(req.params.id), req.user.id]);
  res.status(204).end();
});

vaghinakRouter.post("/messages/:id/react", async (req, res) => {
  const reaction = req.body?.reaction;
  if (!["helpful", "not_relevant"].includes(reaction)) return res.status(400).json({ error: "reaction must be helpful or not_relevant" });
  const { rowCount } = await pool.query(`UPDATE vaghinak_messages SET reaction = $1 WHERE id = $2 AND user_id = $3 AND NOT shadow`, [reaction, Number(req.params.id), req.user.id]);
  if (!rowCount) return res.status(404).json({ error: "Message not found" });
  res.status(204).end();
});

vaghinakRouter.post("/messages/:id/answer", async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query("SELECT * FROM vaghinak_messages WHERE id = $1 AND user_id = $2 AND NOT shadow", [id, req.user.id]);
  const message = rows[0];
  if (!message) return res.status(404).json({ error: "Message not found" });
  if (!message.needs_answer) return res.status(409).json({ error: "This message is not a question" });
  if (message.answered_at) return res.status(409).json({ error: "Already answered" });
  const choice = typeof req.body?.choice === "string" ? req.body.choice : null;
  const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 500) : "";
  const keys = (message.choices ?? []).map((c) => c.key);
  if (choice && !keys.includes(choice)) return res.status(400).json({ error: "Unknown choice" });
  if (!choice && !text) return res.status(400).json({ error: "Pick an answer or write one" });
  if (choice === "other" && !text) return res.status(400).json({ error: "Please write a few words" });
  await pool.query("UPDATE vaghinak_messages SET answer_choice = $1, answer_text = $2, answered_at = now(), read_at = COALESCE(read_at, now()) WHERE id = $3", [choice, text || null, id]);
  // "Day off" / "sick": he stays quiet for the rest of today and the day does not count against the rep
  if (choice === "day_off" || choice === "sick") {
    const day = yerevanToday();
    await pool.query("UPDATE users SET vaghinak_muted_day = $2 WHERE id = $1", [req.user.id, day]);
    await pool.query(
      `INSERT INTO vaghinak_day_log (user_id, day, day_off) VALUES ($1, $2, true)
       ON CONFLICT (user_id, day) DO UPDATE SET day_off = true`,
      [req.user.id, day]
    );
  }
  res.json({ count: await badgeCount(req.user.id) });
});

// ---- management ----

// Why the automatic debt / reorder tasks were or were not created (they run after every Excel sync, not on a timer).
vaghinakRouter.get("/auto-tasks", requireManagement, async (_req, res) => res.json(await autoTaskDiagnostics()));

vaghinakRouter.get("/pulse", requireManagement, async (_req, res) => res.json(await teamPulse()));

// Every question he asked and what was answered (newest first), including shadow-mode ones.
vaghinakRouter.get("/qa", requireManagement, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.kind, m.day, m.level, m.body, m.mandatory, m.choices, m.answer_choice, m.answer_text, m.answered_at, m.created_at, m.shadow,
            u.id AS user_id, COALESCE(u.name_hy, u.name) AS user_name
     FROM vaghinak_messages m JOIN users u ON u.id = m.user_id
     WHERE m.needs_answer AND m.created_at > now() - interval '30 days'
     ORDER BY m.created_at DESC LIMIT 200`
  );
  res.json(rows);
});

// Everything he has said lately, to anybody (so management can judge tone and tune him, also in shadow mode).
vaghinakRouter.get("/feed", requireManagement, async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT m.id, m.kind, m.day, m.level, m.body, m.shadow, m.needs_answer, m.mandatory, m.answered_at, m.reaction, m.created_at,
            COALESCE(u.name_hy, u.name) AS user_name, u.role AS user_role
     FROM vaghinak_messages m JOIN users u ON u.id = m.user_id
     ORDER BY m.created_at DESC LIMIT 100`
  );
  res.json(rows);
});

vaghinakRouter.get("/settings", requireManagement, async (_req, res) => {
  const { rows: people } = await pool.query(
    `SELECT id, name, name_hy, role, vaghinak_address FROM users WHERE status = 'active' ORDER BY (role = 'sales_manager') DESC, name`
  );
  res.json({ settings: await getVaghinakSettings(), people });
});

vaghinakRouter.put("/settings", requireSettingsRole, async (req, res) => {
  try {
    await saveVaghinakSettings(req.body ?? {});
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  res.json(await getVaghinakSettings());
});

vaghinakRouter.put("/people/:id/address", requireSettingsRole, async (req, res) => {
  const address = typeof req.body?.address === "string" ? req.body.address.trim().slice(0, 60) : "";
  const { rowCount } = await pool.query("UPDATE users SET vaghinak_address = $2 WHERE id = $1", [Number(req.params.id), address || null]);
  if (!rowCount) return res.status(404).json({ error: "User not found" });
  res.status(204).end();
});

// Mute a rep for today (management: day off, or "leave him alone today") / unmute.
vaghinakRouter.put("/people/:id/mute", requireSettingsRole, async (req, res) => {
  const on = req.body?.muted === true;
  const { rowCount } = await pool.query("UPDATE users SET vaghinak_muted_day = $2 WHERE id = $1", [Number(req.params.id), on ? yerevanToday() : null]);
  if (!rowCount) return res.status(404).json({ error: "User not found" });
  res.status(204).end();
});

// Run one pass now (testing / "check them right now"): admin only.
vaghinakRouter.post("/run-now", async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Not allowed" });
  const now = new Date();
  // an admin pressing "run now" wants the result now: no human delay
  const a = await tick(now, undefined, { delayMaxMs: 0 });
  const b = await wrapUp(now, undefined, { delayMaxMs: 0 });
  res.json({ created: a.created + b.created });
});
