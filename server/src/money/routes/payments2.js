// The redesigned payments (owner, 2026-11-02), release 1: the records, the books track and voiding run on the server; the new screens come in
// the next releases. Until then this is read by admin / CEO / the accountant to compare the new matching with the old module.
//   GET  /status       counts by cash and books track, payments the old module and the new rule see differently, Excel cash rows nobody recorded
//   GET  /:id          one payment: its Excel rows and its history
//   POST /run          copy from the old module + match now (admin)
//   POST /:id/void     { reason } -- the collector while the cash is still his, else admin / CEO
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { seesPaymentBooks } from "../../shared/roles.js";
import { IN_EXCEL_SQL } from "../paymentExcelMatch.js";
import { getCutover, isLive, voidPayment } from "../payments2/service.js";
import { runBridge } from "../payments2/bridge.js";
import { runBooks, unrecordedCashRows } from "../payments2/books.js";

export const payments2Router = Router();
payments2Router.use(requireAuth);

payments2Router.get("/status", async (req, res) => {
  if (!seesPaymentBooks(req.user.role)) return res.status(403).json({ error: "Not allowed" });
  const cutover = await getCutover();
  const [{ rows: [counts] }, { rows: differ }, unrecorded, live] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE voided_at IS NOT NULL)::int AS voided,
              count(*) FILTER (WHERE voided_at IS NULL AND cash_state = 'collected')::int AS collected,
              count(*) FILTER (WHERE voided_at IS NULL AND cash_state = 'counted')::int AS counted,
              count(*) FILTER (WHERE voided_at IS NULL AND cash_state = 'received')::int AS received,
              count(*) FILTER (WHERE voided_at IS NULL AND books_state = 'open')::int AS books_open,
              count(*) FILTER (WHERE voided_at IS NULL AND books_state <> 'open')::int AS books_booked,
              COALESCE(sum(amount_amd) FILTER (WHERE voided_at IS NULL), 0)::float8 AS amount,
              COALESCE(sum(amount_amd) FILTER (WHERE voided_at IS NULL AND books_state = 'open'), 0)::float8 AS amount_open
       FROM customer_payments WHERE pay_day >= $1`,
      [cutover]
    ),
    // the same payment, judged by the old module ("in Excel") and by the new rule (booked)
    pool.query(
      `SELECT cp.id, cp.legacy_payment_id, cp.customer_name_snapshot AS customer, cp.erp_customer_id_snapshot AS erp, cp.amount_amd::float8 AS amount,
              to_char(cp.pay_day, 'YYYY-MM-DD') AS day, cp.books_state, cp.books_note, ${IN_EXCEL_SQL} AS old_in_excel, p.status AS old_status
       FROM customer_payments cp JOIN payments p ON p.id = cp.legacy_payment_id
       WHERE cp.voided_at IS NULL AND (${IN_EXCEL_SQL}) <> (cp.books_state <> 'open')
       ORDER BY cp.pay_day DESC, cp.id DESC LIMIT 100`
    ),
    unrecordedCashRows(),
    isLive(),
  ]);
  res.json({
    cutover,
    live,
    counts,
    differ,
    unrecorded_cash_rows: unrecorded.map((r) => ({ erp: r.erp, day: r.day, amount: r.amount, free: r.free, account: r.accountName, excel_row: r.excelRow })),
  });
});

payments2Router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  const { rows } = await pool.query("SELECT * FROM customer_payments WHERE id = $1", [id]);
  const p = rows[0];
  if (!p) return res.status(404).json({ error: "Payment not found" });
  if (!seesPaymentBooks(req.user.role) && p.collected_by !== req.user.id && p.holder_id !== req.user.id) return res.status(403).json({ error: "Not allowed" });
  const [{ rows: links }, { rows: events }] = await Promise.all([
    pool.query("SELECT entry_date, entry_amount_amd, account_name, excel_row, amount_amd, how, linked_at FROM payment_book_links WHERE payment_id = $1 ORDER BY entry_date", [id]),
    pool.query("SELECT e.at, e.kind, e.detail, u.name AS actor FROM customer_payment_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.payment_id = $1 ORDER BY e.at, e.id", [id]),
  ]);
  res.json({ payment: p, links, events });
});

payments2Router.post("/run", async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Not allowed" });
  const bridge = await runBridge();
  const books = await runBooks();
  res.json({ bridge, books });
});

payments2Router.post("/:id/void", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  const r = await voidPayment(pool, req.user, id, req.body?.reason);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json(r.payment);
});
