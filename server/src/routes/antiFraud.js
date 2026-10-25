// Anti-fraud page data for management (admin, CEO, operations director): rep risk scores, open findings, the weekly check calls, the limits.
// See antiFraud.js for the signals.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import {
  FRAUD_VIEW_ROLES, FRAUD_SETTINGS_ROLES, getFraudSettings, saveFraudSettings, getWeights, repRisk,
  ensureWeeklySpotChecks, resolveSpotCheck, learnFromVerdict, runAntiFraud,
} from "../antiFraud.js";

export const antiFraudRouter = Router();
antiFraudRouter.use(requireAuth);
antiFraudRouter.use((req, res, next) => (FRAUD_VIEW_ROLES.includes(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" })));

antiFraudRouter.get("/", async (req, res) => {
  await ensureWeeklySpotChecks().catch((err) => console.error("Spot checks failed:", err.message));
  const [settings, weights, reps, open, recent, checks] = await Promise.all([
    getFraudSettings(),
    getWeights(),
    repRisk(),
    pool.query(
      `SELECT a.id, a.kind, a.severity, a.rep_id, a.customer_id, a.payment_id, a.amount_amd, a.details, a.created_at,
              COALESCE(u.name_hy, u.name) AS rep_name, c.name AS customer_name
         FROM fraud_alerts a LEFT JOIN users u ON u.id = a.rep_id LEFT JOIN customers c ON c.id = a.customer_id
        WHERE a.status = 'open' ORDER BY a.severity DESC, a.created_at DESC LIMIT 200`
    ),
    pool.query(
      `SELECT a.id, a.kind, a.status, a.note, a.amount_amd, a.details, a.resolved_at, COALESCE(u.name_hy, u.name) AS rep_name
         FROM fraud_alerts a LEFT JOIN users u ON u.id = a.rep_id
        WHERE a.status IN ('confirmed', 'false_alarm') ORDER BY a.resolved_at DESC NULLS LAST LIMIT 15`
    ),
    pool.query(
      `SELECT s.id, s.week_start, s.payment_id, s.customer_id, s.customer_name, s.customer_phone, s.amount_amd, s.payment_date, s.status, s.note,
              COALESCE(u.name_hy, u.name) AS rep_name
         FROM fraud_spot_checks s LEFT JOIN users u ON u.id = s.rep_id
        WHERE s.week_start >= (now() AT TIME ZONE 'Asia/Yerevan')::date - 14 ORDER BY s.week_start DESC, s.id`
    ),
  ]);
  res.json({ settings, can_edit: FRAUD_SETTINGS_ROLES.includes(req.user.role), weights, reps, alerts: open.rows, recent: recent.rows, spot_checks: checks.rows });
});

// confirmed / false_alarm: the verdict that also teaches him which signals matter
antiFraudRouter.patch("/alerts/:id", async (req, res) => {
  const status = req.body?.status;
  if (!["confirmed", "false_alarm"].includes(status)) return res.status(400).json({ error: "status must be confirmed or false_alarm" });
  const { rows } = await pool.query(
    `UPDATE fraud_alerts SET status = $2, note = $3, resolved_at = now(), resolved_by = $4, updated_at = now()
      WHERE id = $1 AND status = 'open' RETURNING id, kind`,
    [req.params.id, status, req.body?.note ? String(req.body.note).slice(0, 300) : null, req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Finding not found or already decided" });
  await learnFromVerdict(rows[0].kind, status);
  res.json({ ok: true });
});

antiFraudRouter.patch("/spot-checks/:id", async (req, res) => {
  try {
    const row = await resolveSpotCheck(req.params.id, req.body?.status, req.body?.note, req.user.id);
    if (!row) return res.status(404).json({ error: "Check not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

antiFraudRouter.put("/settings", async (req, res) => {
  if (!FRAUD_SETTINGS_ROLES.includes(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  try {
    await saveFraudSettings(req.body);
    res.json(await getFraudSettings());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// "Look now" instead of waiting for the next hourly run
antiFraudRouter.post("/run-now", async (_req, res) => res.json(await runAntiFraud()));
