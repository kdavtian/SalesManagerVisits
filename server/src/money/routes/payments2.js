// The redesigned payments (owner, 2026-11-02), release 1: the records, the books track and voiding run on the server; the new screens come in
// the next releases. Until then this is read by admin / CEO / the accountant to compare the new matching with the old module.
//   GET  /status       counts by cash and books track, payments the old module and the new rule see differently, Excel cash rows nobody recorded
//   GET  /:id          one payment: its Excel rows and its history
//   POST /run          copy from the old module + match now (admin)
//   POST /:id/void     { reason } -- the collector while the cash is still his, else admin / CEO
// Release 2 (owner, 2026-11-02): cash desks and bank payments (accountant, admin, CEO; desks are edited by admin)
//   GET  /setup                     the bank accounts for the form, what this person may do, the Unspecified count
//   GET  /bank/unspecified          statement lines waiting for the accountant + cash held by people without a desk
//   GET  /bank/payments             bank / card payments since the cutover
//   POST /bank/payments             { customer_id, amount, day, account_id, method, note, client_ref, separate } -- typed by hand
//   POST /bank/lines/:id/resolve    { action: customer | not_customer | separate | duplicate | reopen, customer_id, remember }
//   POST /:id/customer              { customer_id, reason } -- a bank payment moves to the right customer
//   GET  /desks                     the cash desks with holders and the cash waiting on each; reps without a desk
//   POST /desks, PATCH /desks/:id   { name, holder_ids, active } (admin); POST /desks/auto: every rep without a desk gets his own (admin)
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { requireAuth } from "../../middleware/auth.js";
import { canManageCashDesks, canRecordBankPayments, canVoidCountedPayment, seesPaymentBooks } from "../../shared/roles.js";
import { IN_EXCEL_SQL } from "../paymentExcelMatch.js";
import { getCutover, isLive, voidPayment } from "../payments2/service.js";
import { runBridge } from "../payments2/bridge.js";
import { runBooks, unrecordedCashRows } from "../payments2/books.js";
import { changeCustomer, recordByHand, resolveLine } from "../payments2/bankPayments.js";
import { ensureAllRepDesks, listDesks, repsWithoutDesk, saveDesk } from "../payments2/desks.js";
import { moneyBoard } from "../payments2/board.js";

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

// ---- release 2: bank payments and cash desks (before /:id) ----------------------------------------------------------------------
const bankOnly = (req, res, next) => (canRecordBankPayments(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));
const desksAdmin = (req, res, next) => (canManageCashDesks(req.user.role) ? next() : res.status(403).json({ error: "Not allowed" }));
const sendResult = (res, r, okStatus = 200) => (r.error ? res.status(r.status).json({ error: r.error, ...(r.duplicates ? { duplicates: r.duplicates } : {}) }) : res.status(okStatus).json(r));

const UNSPECIFIED_COUNT_SQL = "SELECT count(*)::int AS n FROM bank_statement_lines WHERE pay_state = 'unspecified'";
const NO_DESK_SQL = `SELECT p.holder_id AS user_id, u.name, count(*)::int AS count, sum(p.amount_amd)::float8 AS amount
                     FROM customer_payments p LEFT JOIN users u ON u.id = p.holder_id
                     WHERE p.method = 'cash' AND p.voided_at IS NULL AND p.cash_state IN ('collected', 'counted') AND p.account_id IS NULL AND p.pay_day >= $1
                     GROUP BY p.holder_id, u.name ORDER BY u.name`;

payments2Router.get("/setup", bankOnly, async (req, res) => {
  const cutover = await getCutover();
  const [{ rows: accounts }, { rows: [u] }, { rows: noDesk }] = await Promise.all([
    pool.query("SELECT id, name, kind FROM cash_accounts WHERE active AND kind IN ('bank', 'card') ORDER BY sort_order, lower(name)"),
    pool.query(UNSPECIFIED_COUNT_SQL),
    pool.query(NO_DESK_SQL, [cutover]),
  ]);
  res.json({
    cutover,
    bank_accounts: accounts,
    unspecified: u.n + noDesk.length,
    can_manage_desks: canManageCashDesks(req.user.role),
    can_void: canVoidCountedPayment(req.user.role),
  });
});

// The daily money board (release 4): ?day=YYYY-MM-DD, default today (Yerevan).
payments2Router.get("/board", bankOnly, async (req, res) => {
  const { rows: [t] } = await pool.query("SELECT to_char((now() AT TIME ZONE 'Asia/Yerevan')::date, 'YYYY-MM-DD') AS today");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day ?? "")) && req.query.day <= t.today ? req.query.day : t.today;
  res.json(await moneyBoard(pool, day));
});

payments2Router.get("/bank/unspecified", bankOnly, async (req, res) => {
  const cutover = await getCutover();
  const [{ rows: lines }, { rows: noDesk }] = await Promise.all([
    pool.query(
      `SELECT l.id, to_char(l.line_date, 'YYYY-MM-DD') AS day, round(l.amount)::float8 AS amount, l.counterparty, l.description, l.reference,
              a.name AS account, l.pay_reason AS reason, l.pay_customer_id AS customer_id, c.name AS customer_name, c.erp_customer_id AS customer_erp,
              CASE WHEN o.id IS NULL THEN NULL ELSE json_build_object('id', o.id, 'day', to_char(o.line_date, 'YYYY-MM-DD'), 'customer', op.customer_name_snapshot, 'payment_id', op.id) END AS copy_of
       FROM bank_statement_lines l JOIN cash_accounts a ON a.id = l.account_id LEFT JOIN customers c ON c.id = l.pay_customer_id
       LEFT JOIN bank_statement_lines o ON o.id = l.pay_copy_of LEFT JOIN customer_payments op ON op.bank_line_id = o.id
       WHERE l.pay_state = 'unspecified' ORDER BY l.line_date DESC, l.id DESC LIMIT 500`
    ),
    pool.query(NO_DESK_SQL, [cutover]),
  ]);
  res.json({ lines, no_desk: noDesk });
});

payments2Router.get("/bank/payments", bankOnly, async (req, res) => {
  const cutover = await getCutover();
  const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit, 10) || 300));
  const { rows } = await pool.query(
    `SELECT p.id, to_char(p.pay_day, 'YYYY-MM-DD') AS day, p.customer_id, p.customer_name_snapshot AS customer, p.erp_customer_id_snapshot AS erp,
            p.amount_amd::float8 AS amount, p.method, a.name AS account, p.source, p.payer_match, p.books_state, p.books_note, p.voided_at, p.void_reason, p.note,
            p.cash_state, hu.name AS holder_name, p.legacy_payment_id,
            p.created_at, u.name AS created_by_name,
            CASE WHEN l.id IS NULL THEN NULL ELSE json_build_object('id', l.id, 'day', to_char(l.line_date, 'YYYY-MM-DD'), 'counterparty', l.counterparty, 'description', l.description) END AS line
     FROM customer_payments p LEFT JOIN cash_accounts a ON a.id = p.account_id LEFT JOIN bank_statement_lines l ON l.id = p.bank_line_id
     LEFT JOIN users u ON u.id = p.created_by LEFT JOIN users hu ON hu.id = p.holder_id
     WHERE (p.method IN ('bank', 'card') OR $3) AND p.pay_day >= $1 ORDER BY p.pay_day DESC, p.id DESC LIMIT $2`,
    [cutover, limit, req.query.methods === "all"]
  );
  res.json({ payments: rows });
});

payments2Router.post("/bank/payments", bankOnly, async (req, res) => {
  const r = await recordByHand(pool, req.user, req.body);
  sendResult(res, r, r.existing ? 200 : 201);
});

payments2Router.post("/bank/lines/:id/resolve", bankOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  sendResult(res, await resolveLine(pool, req.user, id, req.body));
});

payments2Router.get("/desks", bankOnly, async (req, res) => {
  const manage = canManageCashDesks(req.user.role);
  const [desks, reps, people] = await Promise.all([
    listDesks(),
    repsWithoutDesk(),
    manage
      ? pool.query("SELECT id, name, role FROM users WHERE status = 'active' AND role <> 'customer' ORDER BY name").then((r) => r.rows)
      : Promise.resolve([]),
  ]);
  res.json({ desks, reps_without_desk: reps, people, can_manage: manage });
});

payments2Router.post("/desks/auto", desksAdmin, async (req, res) => {
  res.json({ made: await ensureAllRepDesks() });
});

payments2Router.post("/desks", desksAdmin, async (req, res) => {
  sendResult(res, await saveDesk(pool, null, req.body ?? {}), 201);
});

payments2Router.patch("/desks/:id", desksAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  sendResult(res, await saveDesk(pool, id, req.body ?? {}));
});

payments2Router.post("/:id/customer", bankOnly, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id" });
  sendResult(res, await changeCustomer(pool, req.user, id, req.body));
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
