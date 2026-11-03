// A person's desktop table settings (migration 180): GET all of mine, PUT one table, DELETE one (back to the default).
// Only ever the caller's own rows (user_id comes from the session, never from the request).
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";

export const tablePrefsRouter = Router();
tablePrefsRouter.use(requireAuth);

const KEY = /^[a-z0-9_.:-]{1,60}$/;
const COLUMN_KEY = /^[a-zA-Z0-9_.:-]{1,40}$/;

// Keeps only what the screen understands: column keys (strings), a boolean; anything else is dropped.
export function cleanConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = (list) => (Array.isArray(list) ? [...new Set(list.filter((k) => typeof k === "string" && COLUMN_KEY.test(k)))].slice(0, 60) : []);
  return { order: keys(raw.order), on: keys(raw.on), fit: raw.fit !== false };
}

tablePrefsRouter.get("/", async (req, res) => {
  const { rows } = await pool.query("SELECT page_key, config, updated_at FROM user_table_prefs WHERE user_id = $1", [req.user.id]);
  res.json({ prefs: Object.fromEntries(rows.map((r) => [r.page_key, { ...r.config, updated_at: r.updated_at }])) });
});

tablePrefsRouter.put("/:page", async (req, res) => {
  if (!KEY.test(req.params.page)) return res.status(400).json({ error: "Invalid table" });
  const config = cleanConfig(req.body?.config);
  if (!config) return res.status(400).json({ error: "Invalid settings" });
  await pool.query(
    `INSERT INTO user_table_prefs (user_id, page_key, config) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, page_key) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [req.user.id, req.params.page, config]
  );
  res.json({ ok: true });
});

tablePrefsRouter.delete("/:page", async (req, res) => {
  if (!KEY.test(req.params.page)) return res.status(400).json({ error: "Invalid table" });
  await pool.query("DELETE FROM user_table_prefs WHERE user_id = $1 AND page_key = $2", [req.user.id, req.params.page]);
  res.json({ ok: true });
});
