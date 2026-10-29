// Stock count (Գույքագրում) screens: the day's counting list, a count saved / taken back, "Finish the day", and the month for management.
// The rules (plan, carry-over, report + task) live in ../stockCount.js.
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { canCountStock, canViewStockCount, seesStockCountExpected } from "../../shared/roles.js";
import { yerevanToday, yerevanMonthStart } from "../../utils/yerevanDate.js";
import { dayList, saveCount, clearCount, closeDay, monthReport } from "../stockCount.js";

export const stockCountRouter = Router();
stockCountRouter.use(requireAuth);
stockCountRouter.use((req, res, next) => (canViewStockCount(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" })));
const counter = (req, res, next) => (canCountStock(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ?day=YYYY-MM-DD (default today; an earlier day is read-only)
stockCountRouter.get("/day", async (req, res) => {
  const today = yerevanToday();
  const day = DAY.test(String(req.query.day ?? "")) && req.query.day <= today ? String(req.query.day) : today;
  const list = await dayList(pool, day, { showExpected: seesStockCountExpected(req.user.role) || day < today });
  res.json({ ...list, today, can_count: canCountStock(req.user.role) && day === today });
});

stockCountRouter.put("/items/:productId", counter, async (req, res) => {
  const qty = req.body?.qty;
  const r = await saveCount(pool, req.user, { productId: Number(req.params.productId), qty: typeof qty === "number" ? qty : Number.NaN, note: req.body?.note });
  if (r.error) return res.status(r.status).json({ error: r.error });
  // the counter is told the difference only once the day is closed
  res.json(seesStockCountExpected(req.user.role) ? { ...r.item, difference: r.item.counted_qty - (r.item.expected_qty ?? 0) } : { product_id: r.item.product_id, counted_qty: r.item.counted_qty });
});

stockCountRouter.delete("/items/:productId", counter, async (req, res) => {
  const r = await clearCount(pool, Number(req.params.productId));
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json(r);
});

stockCountRouter.post("/finish", counter, async (req, res) => {
  const today = yerevanToday();
  const r = await closeDay(pool, today, req.user.id);
  if (r.empty) return res.status(400).json({ error: "Nothing to count today" });
  res.json(await dayList(pool, today, { showExpected: true }));
});

// ?month=YYYY-MM
stockCountRouter.get("/month", async (req, res) => {
  const m = /^\d{4}-\d{2}$/.test(String(req.query.month ?? "")) ? `${req.query.month}-01` : yerevanMonthStart();
  res.json(await monthReport(pool, m));
});
