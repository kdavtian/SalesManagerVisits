// Daily cash sheets in the app (cashSheets.js): the list with "posted to Telegram" and "recorded in Excel", the Excel file, and the
// accountant's "Recorded in Excel" mark (undoable). A rep sees only his own sheets; management, the accountant and the sales director see all.
import { Router } from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { cashSheetFilename, cashSheetXlsx, loadCashSheet } from "../cashSheets.js";

export const cashSheetsRouter = Router();
cashSheetsRouter.use(requireAuth);

const SEES_ALL = new Set(["admin", "ceo", "operations_director", "sales_director", "accountant"]);
const RECORDS = new Set(["admin", "accountant"]);
const canSee = (user, sheet) => SEES_ALL.has(user.role) || (user.role === "sales_manager" && sheet.rep_id === user.id);

cashSheetsRouter.get("/", async (req, res) => {
  if (!SEES_ALL.has(req.user.role) && req.user.role !== "sales_manager") return res.status(403).json({ error: "Not allowed" });
  const mine = !SEES_ALL.has(req.user.role);
  const { rows } = await pool.query(
    `SELECT s.id, s.handoff_id, to_char(s.sheet_date, 'YYYY-MM-DD') AS sheet_date, s.total_amd, s.counted_amd, s.item_count, s.created_at,
            s.posted_at, s.last_post_error, s.recorded_at, s.recorded_auto, r.name AS rep_name, d.name AS director_name, rb.name AS recorded_by_name
     FROM cash_sheets s LEFT JOIN users r ON r.id = s.rep_id LEFT JOIN users d ON d.id = s.director_id LEFT JOIN users rb ON rb.id = s.recorded_by
     WHERE s.created_at > now() - interval '60 days' ${mine ? "AND s.rep_id = $1" : ""}
     ORDER BY (s.recorded_at IS NULL) DESC, s.id DESC LIMIT 200`,
    mine ? [req.user.id] : []
  );
  res.json({ sheets: rows.map((r) => ({ ...r, total_amd: Number(r.total_amd), counted_amd: Number(r.counted_amd) })), can_record: RECORDS.has(req.user.role) });
});

cashSheetsRouter.get("/:id/xlsx", async (req, res) => {
  const data = await loadCashSheet(Number(req.params.id));
  if (!data) return res.status(404).json({ error: "Cash sheet not found" });
  if (!canSee(req.user, data.sheet)) return res.status(403).json({ error: "Not allowed" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${cashSheetFilename(data)}"`);
  res.send(await cashSheetXlsx(data));
});

// { recorded: true | false } -- the accountant's mark; false undoes a mistaken tap (also an automatic close, if the Excel row was wrong).
cashSheetsRouter.post("/:id/recorded", async (req, res) => {
  if (!RECORDS.has(req.user.role)) return res.status(403).json({ error: "Only the accountant marks a sheet recorded" });
  const on = req.body?.recorded !== false;
  const { rows } = await pool.query(
    on
      ? `UPDATE cash_sheets SET recorded_at = COALESCE(recorded_at, now()),
                recorded_by = CASE WHEN recorded_at IS NULL THEN $2 ELSE recorded_by END,
                recorded_auto = CASE WHEN recorded_at IS NULL THEN false ELSE recorded_auto END
         WHERE id = $1 RETURNING id`
      : "UPDATE cash_sheets SET recorded_at = NULL, recorded_by = NULL, recorded_auto = false WHERE id = $1 AND $2::int IS NOT NULL RETURNING id",
    [Number(req.params.id), req.user.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Cash sheet not found" });
  res.json({ ok: true, recorded: on });
});
