// The weekly AI strategy's talking points for ONE customer (team/vaghinak/strategist.js), read at the check-in: the customer's own sales
// manager sees them when management switched them on (strategyRepPoints); management always. Only this week's report counts.
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { seesAllPerformance } from "../../shared/roles.js";
import { pool } from "../../db/pool.js";
import { getVaghinakSettings } from "../vaghinak/settings.js";
import { mondayOf } from "../vaghinak/digest.js";
import { yerevanToday } from "../../utils/yerevanDate.js";

export const salesPointsRouter = Router();
salesPointsRouter.use(requireAuth);

salesPointsRouter.get("/:customerId", async (req, res) => {
  const id = Number(req.params.customerId);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Bad customer" });
  const management = seesAllPerformance(req.user.role);
  const { rows: [c] } = await pool.query("SELECT assigned_manager_id FROM customers WHERE id = $1", [id]);
  // someone else's customer reads like no customer
  if (!c || (!management && !(req.user.role === "sales_manager" && c.assigned_manager_id === req.user.id))) return res.status(404).json({ error: "Not found" });
  const settings = await getVaghinakSettings();
  if (!management && (settings.strategyRepPoints !== "on" || settings.mode === "off")) return res.json({ points: [] });
  const { rows: [r] } = await pool.query("SELECT report -> 'talking_points' AS tps FROM sales_strategy_reports WHERE week_start = $1", [mondayOf(yerevanToday())]);
  const tp = (Array.isArray(r?.tps) ? r.tps : []).find((x) => Array.isArray(x?.customer_ids) && x.customer_ids.includes(id));
  res.json({ points: Array.isArray(tp?.points) ? tp.points.filter((p) => typeof p === "string").slice(0, 4) : [] });
});
