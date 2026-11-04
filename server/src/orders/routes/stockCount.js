// Stock count (Գույքագրում) screens: the day's counting list, a count saved / taken back, "Finish the day", and the month for management.
// The rules (plan, carry-over, report + task) live in ../stockCount.js.
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { canCountStock, canViewStockCount, seesStockCountExpected } from "../../shared/roles.js";
import { yerevanToday, yerevanMonthStart } from "../../utils/yerevanDate.js";
import path from "node:path";
import fs from "node:fs";
import { dayList, saveCount, clearCount, closeDay, monthReport, savePdf } from "../stockCount.js";
import { stockCountUpload, stockCountDirPath } from "../../shared/upload.js";
import { PDF_LAYOUT } from "../stockCountPdf.js";

export const stockCountRouter = Router();
stockCountRouter.use(requireAuth);
stockCountRouter.use((req, res, next) => (canViewStockCount(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" })));
const counter = (req, res, next) => (canCountStock(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// ?day=YYYY-MM-DD (default today; an earlier day is read-only)
stockCountRouter.get("/day", async (req, res) => {
  const today = yerevanToday();
  const day = DAY.test(String(req.query.day ?? "")) && req.query.day <= today ? String(req.query.day) : today;
  const list = await dayList(pool, day, { showExpected: seesStockCountExpected(req.user.role) || day < today });
  res.json({ ...list, today, can_count: canCountStock(req.user.role) && day === today });
});

stockCountRouter.put("/items/:productId", counter, async (req, res) => {
  const qty = req.body?.qty;
  // A count made without signal reaches the server later: it is saved on the day it was counted (not older than 3 days, never in the future)
  const today = yerevanToday();
  const asked = String(req.body?.day ?? "");
  const day = DAY.test(asked) && asked <= today && asked >= addDays(today, -3) ? asked : today;
  const r = await saveCount(pool, req.user, { productId: Number(req.params.productId), qty: typeof qty === "number" ? qty : Number.NaN, note: req.body?.note }, day);
  if (r.error) return res.status(r.status).json({ error: r.error });
  // the counter is told the difference only once the day is closed
  res.json(seesStockCountExpected(req.user.role) ? { ...r.item, difference: r.item.counted_qty - (r.item.expected_qty ?? 0) } : { product_id: r.item.product_id, counted_qty: r.item.counted_qty });
});

stockCountRouter.delete("/items/:productId", counter, async (req, res) => {
  const r = await clearCount(pool, Number(req.params.productId));
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json(r);
});

// "Finish the day": the counter's drawn signature is mandatory (field `signature`, a PNG); a photo or PDF of the paper count (`attachment`) is
// optional. Both are kept with the day and go into its PDF report.
const finishUpload = stockCountUpload.fields([{ name: "signature", maxCount: 1 }, { name: "attachment", maxCount: 1 }]);
stockCountRouter.post("/finish", counter, (req, res, next) => finishUpload(req, res, (err) => (err ? res.status(400).json({ error: err.message }) : next())), async (req, res) => {
  const today = yerevanToday();
  const signature = req.files?.signature?.[0];
  const attachment = req.files?.attachment?.[0];
  const discard = () => [signature, attachment].filter(Boolean).forEach((f) => fs.promises.unlink(f.path).catch(() => {}));
  if (!signature) {
    discard();
    return res.status(400).json({ error: "Sign the stock count to finish the day", code: "signature_required" });
  }
  const r = await closeDay(pool, today, req.user.id, {
    signaturePath: signature.filename,
    attachmentPath: attachment?.filename ?? null,
    attachmentMime: attachment?.mimetype ?? null,
  });
  if (r.empty || r.already) discard(); // nothing was closed by this call: the files are not kept
  if (r.empty) return res.status(400).json({ error: "Nothing to count today" });
  res.json(await dayList(pool, today, { showExpected: true }));
});

// The day's report (PDF) -- made again when the file is missing. Everyone who may open the stock count: the counter, the accountants, the bosses.
stockCountRouter.get("/day/:day/pdf", async (req, res) => {
  const day = String(req.params.day);
  if (!DAY.test(day)) return res.status(400).json({ error: "Invalid day" });
  const { rows: [d] } = await pool.query("SELECT pdf_path FROM stock_count_days WHERE day = $1", [day]);
  if (!d) return res.status(404).json({ error: "This day is not finished yet" });
  let file = d.pdf_path;
  // missing, or saved with an older layout (PDF_LAYOUT in the file name): made again from the same saved numbers and signature
  if (!file || !path.basename(file).includes(`-${PDF_LAYOUT}-`) || !fs.existsSync(path.join(stockCountDirPath, path.basename(file)))) file = await savePdf(pool, day);
  if (!file) return res.status(404).json({ error: "No report" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="Stock-count-${day}.pdf"`);
  res.sendFile(path.join(stockCountDirPath, path.basename(file)));
});

// The photo / PDF of the paper count that came with the day, when there is one.
stockCountRouter.get("/day/:day/attachment", async (req, res) => {
  const day = String(req.params.day);
  if (!DAY.test(day)) return res.status(400).json({ error: "Invalid day" });
  const { rows: [d] } = await pool.query("SELECT attachment_path, attachment_mime FROM stock_count_days WHERE day = $1", [day]);
  if (!d?.attachment_path) return res.status(404).json({ error: "No attachment" });
  res.setHeader("Content-Type", d.attachment_mime || "application/octet-stream");
  res.sendFile(path.join(stockCountDirPath, path.basename(d.attachment_path)));
});

// The finished days with their reports, newest first: the Documents page lists them for the accountants and the bosses.
stockCountRouter.get("/documents", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT to_char(s.day, 'YYYY-MM-DD') AS day, s.counted, s.planned, s.differences, s.left_over, s.finished_at,
            (s.signature_path IS NOT NULL) AS signed, (s.attachment_path IS NOT NULL) AS has_attachment,
            COALESCE(u.name_hy, u.name) AS counter
       FROM stock_count_days s LEFT JOIN users u ON u.id = s.finished_by
      ORDER BY s.day DESC LIMIT 60`
  );
  res.json(rows);
});

// ?month=YYYY-MM
stockCountRouter.get("/month", async (req, res) => {
  const m = /^\d{4}-\d{2}$/.test(String(req.query.month ?? "")) ? `${req.query.month}-01` : yerevanMonthStart();
  res.json(await monthReport(pool, m));
});
