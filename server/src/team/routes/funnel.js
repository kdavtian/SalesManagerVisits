// The Sales funnel screen (Vaghinak - Sales Expert, step 1): every open customer with its stage (team/vaghinak/funnel.js), how long it has stood
// there, and this month's moves between stages. Management only for now (the people who see all performance); the reps get their own
// customers' next steps in step 2.
import express, { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { seesAllPerformance } from "../../shared/roles.js";
import { pool } from "../../db/pool.js";
import { computeFunnel } from "../vaghinak/funnel.js";

export const funnelRouter = Router();
funnelRouter.use(requireAuth);
funnelRouter.use((req, res, next) => (seesAllPerformance(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" })));

funnelRouter.get("/", async (_req, res) => {
  const [{ cfg, customers }, { rows: since }, { rows: moves }] = await Promise.all([
    computeFunnel(),
    pool.query("SELECT customer_id, since FROM customer_funnel_stage"),
    // this calendar month's moves, per customer (the screen counts only the customers its filters show)
    pool.query(
      `SELECT customer_id, from_stage, to_stage FROM customer_funnel_moves
       WHERE moved_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Yerevan') AT TIME ZONE 'Asia/Yerevan')`
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

// The customer's whole monthly need in litres (stage 4 measures our share of it). Until now only a potential customer's sheet wrote it, so a
// tiered customer had no way to get one (review 2026-11-15): management writes it here. 0 / empty clears it.
funnelRouter.put("/customers/:id/expected-volume", express.json(), async (req, res) => {
  const id = Number(req.params.id);
  const raw = req.body?.expected_volume_l;
  const value = raw === null || raw === "" || raw === undefined ? null : Number(raw);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid customer" });
  if (value !== null && !(value >= 0 && value <= 1e6)) return res.status(400).json({ error: "Litres per month: 0 to 1,000,000" });
  const { rowCount } = await pool.query("UPDATE customers SET expected_volume_l = $2, expected_volume_at = now(), expected_volume_by = $3 WHERE id = $1", [id, value || null, req.user.id]);
  if (!rowCount) return res.status(404).json({ error: "Customer not found" });
  res.json({ id, expected_volume_l: value || null });
});
