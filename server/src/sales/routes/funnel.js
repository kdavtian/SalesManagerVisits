// The Sales funnel screen (Vaghinak - Sales Expert, step 1): every open customer with its stage (sales/funnel.js), how long it has stood
// there, and this month's moves between stages. Management only for now (the people who see all performance); the reps get their own
// customers' next steps in step 2.
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { seesAllPerformance } from "../../shared/roles.js";
import { pool } from "../../db/pool.js";
import { computeFunnel } from "../funnel.js";

export const funnelRouter = Router();
funnelRouter.use(requireAuth);
funnelRouter.use((req, res, next) => (seesAllPerformance(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" })));

funnelRouter.get("/", async (_req, res) => {
  const [{ cfg, customers }, { rows: since }, { rows: moves }] = await Promise.all([
    computeFunnel(),
    pool.query("SELECT customer_id, since FROM customer_funnel_stage"),
    // this calendar month in Yerevan
    pool.query(
      `SELECT from_stage, to_stage, COUNT(*)::int AS n FROM customer_funnel_moves
       WHERE moved_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Yerevan') AT TIME ZONE 'Asia/Yerevan')
       GROUP BY 1, 2`
    ),
  ]);
  const sinceOf = new Map(since.map((r) => [r.customer_id, r.since]));
  res.json({
    settings: cfg,
    moves,
    customers: customers.map((c) => ({
      id: c.id,
      name: c.name,
      rep_id: c.rep_id,
      rep_name: c.rep_name,
      region: c.region,
      tier: c.tier,
      potential_level: c.potential_level,
      stage: c.stage,
      progress: c.progress,
      next: c.next,
      groups: c.groups,
      litres_month: c.litres_month,
      expected_volume_l: c.expected_volume_l === null ? null : Number(c.expected_volume_l),
      share: c.share ?? null,
      since: sinceOf.get(c.id) ?? null,
    })),
  });
});
