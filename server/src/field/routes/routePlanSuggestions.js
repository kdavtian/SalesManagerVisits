// Vaghinak's route-plan suggestions for the CEO / admin (field/routePlanAnalysis.js): list, analyse now, accept one / all, dismiss one.
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { canReviewRoutePlanSuggestions } from "../../shared/roles.js";
import { runRoutePlanAnalysis, acceptSuggestion } from "../routePlanAnalysis.js";
import { notifyUser } from "../../shared/notifications.js";

export const routePlanSuggestionsRouter = Router();
routePlanSuggestionsRouter.use(requireAuth);
routePlanSuggestionsRouter.use((req, res, next) => (canReviewRoutePlanSuggestions(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" })));

const SELECT = `SELECT s.id, s.rep_id, u.name AS rep_name, u.name_hy AS rep_name_hy, s.customer_id, c.name AS customer_name, s.kind, s.from_dow, s.to_dow, s.reason, s.status,
                       s.created_at, s.decided_at, d.name AS decided_by_name
                FROM route_plan_suggestions s
                JOIN users u ON u.id = s.rep_id JOIN customers c ON c.id = s.customer_id LEFT JOIN users d ON d.id = s.decided_by`;

routePlanSuggestionsRouter.get("/", async (req, res) => {
  const [{ rows: pending }, { rows: decided }] = await Promise.all([
    pool.query(`${SELECT} WHERE s.status = 'pending' ORDER BY u.name, s.id`),
    pool.query(`${SELECT} WHERE s.status IN ('accepted', 'dismissed') ORDER BY s.decided_at DESC NULLS LAST LIMIT 30`),
  ]);
  res.json({ pending, decided });
});

routePlanSuggestionsRouter.post("/analyze", async (req, res) => {
  const result = await runRoutePlanAnalysis(pool);
  res.json(result);
});

async function applyOne(id, user) {
  const r = await acceptSuggestion(id, user.id);
  if (r.ok) {
    notifyUser(r.suggestion.rep_id, "route_plan_added", { title: "Երթուղային պլանը փոխվեց", body: "Ձեր երթուղային պլանում փոփոխություն կատարվեց (հաստատված առաջարկ)", url: "/#/route-plans" }).catch(() => {});
  }
  return r;
}

routePlanSuggestionsRouter.post("/:id/accept", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  const r = await applyOne(id, req.user);
  if (!r.ok) return res.status(r.reason === "not_found" ? 404 : 409).json({ error: r.reason });
  res.json({ ok: true });
});

routePlanSuggestionsRouter.post("/:id/dismiss", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  const { rowCount } = await pool.query("UPDATE route_plan_suggestions SET status = 'dismissed', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'pending'", [id, req.user.id]);
  if (!rowCount) return res.status(409).json({ error: "not_pending" });
  res.json({ ok: true });
});

// all pending (or the listed ids): each one applied on its own, so a plan that changed meanwhile only skips that one
routePlanSuggestionsRouter.post("/accept-all", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
  const { rows } = await pool.query("SELECT id FROM route_plan_suggestions WHERE status = 'pending' AND ($1::int[] IS NULL OR id = ANY($1)) ORDER BY id", [ids]);
  let accepted = 0;
  let skipped = 0;
  for (const { id } of rows) {
    const r = await applyOne(id, req.user);
    if (r.ok) accepted++;
    else skipped++;
  }
  res.json({ accepted, skipped });
});

