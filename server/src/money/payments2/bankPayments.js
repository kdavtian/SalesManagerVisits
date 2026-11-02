// Bank payments (owner, 2026-11-02): card payments go through the bank too, and the accountants handle both. A payment is recorded by
// hand, or comes from an uploaded bank statement: every new credit line (AMD, from the cutover on, on a bank account) whose payer is
// recognised (payerMatch.js) becomes a customer payment -- or confirms the payment already typed by hand. The same money is never
// recorded twice:
//   - a statement read again adds no line (bank_statement_lines: one line per hash), and a line holds at most one payment (unique index);
//   - a line equal to a payment typed by hand (same customer and amount, within 5 days, same or no account) confirms it, adds nothing;
//   - a line that looks like a second copy of a line already recorded (another upload, same account, day, amount and payer) waits;
//   - typing a payment that looks like one already recorded is refused until the accountant says it is a separate payment.
// Whatever the app cannot decide waits in "Unspecified" for the accountant (pick the customer / not a customer / separate / duplicate).
import { pool } from "../../db/pool.js";
import { addEvent, getCutover } from "./service.js";
import { buildPayerIndex, identifyPayer, payerKey } from "./payerMatch.js";

export const SAME_DAYS = 5;
const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

async function payerIndex(db) {
  const [{ rows: customers }, { rows: rules }] = await Promise.all([
    db.query("SELECT id, tin, name, legal_name FROM customers"),
    db.query("SELECT payer_key, customer_id FROM bank_payers"),
  ]);
  return buildPayerIndex(customers, rules);
}

// Who records the payments of a line the job (not a person) looks at: the person who uploaded it, else the first admin.
async function actorFor(db, line, actorId) {
  if (actorId) return actorId;
  if (line.import_user_id) return line.import_user_id;
  const { rows } = await db.query("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  return rows[0]?.id ?? null;
}

const lineNote = (l) => [l.counterparty, l.description].filter(Boolean).join(" · ").slice(0, 300) || null;

/**
 * The line goes to the customer: it confirms the payment typed by hand for it, or a new payment is made. `checkCopy` = first look whether
 * the line is a second copy of a line already recorded (then it waits as "possible_copy"). Returns { state, paymentId? }.
 */
async function attachLine(db, line, customerId, how, actorId, { checkCopy = true } = {}) {
  const amount = Math.round(Number(line.amount));
  const day = ymd(line.line_date);
  if (checkCopy) {
    const { rows: [copy] } = await db.query(
      `SELECT l.id FROM bank_statement_lines l
       WHERE l.id <> $1 AND l.account_id = $2 AND l.line_date = $3 AND round(l.amount) = $4 AND l.pay_state = 'recorded'
         AND l.import_id IS DISTINCT FROM $5 AND lower(COALESCE(l.counterparty, '')) = lower(COALESCE($6, ''))
       ORDER BY l.id LIMIT 1`,
      [line.id, line.account_id, day, amount, line.import_id, line.counterparty]
    );
    if (copy) {
      await db.query(
        "UPDATE bank_statement_lines SET pay_state = 'unspecified', pay_reason = 'possible_copy', pay_customer_id = $2, pay_copy_of = $3, pay_checked_at = now() WHERE id = $1",
        [line.id, customerId, copy.id]
      );
      return { state: "unspecified" };
    }
  }
  // the payment typed by hand for this money
  const { rows: [typed] } = await db.query(
    `SELECT id FROM customer_payments
     WHERE customer_id = $1 AND bank_line_id IS NULL AND voided_at IS NULL AND method IN ('bank', 'card') AND amount_amd = $2
       AND abs(pay_day - $3::date) <= $4 AND (account_id = $5 OR account_id IS NULL)
     ORDER BY abs(pay_day - $3::date), id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [customerId, amount, day, SAME_DAYS, line.account_id]
  );
  if (typed) {
    await db.query("UPDATE customer_payments SET bank_line_id = $2, account_id = COALESCE(account_id, $3), updated_at = now() WHERE id = $1", [typed.id, line.id, line.account_id]);
    await db.query(
      "UPDATE bank_statement_lines SET pay_state = 'recorded', pay_reason = NULL, pay_customer_id = $2, pay_checked_at = now() WHERE id = $1",
      [line.id, customerId]
    );
    await addEvent(db, typed.id, how === "hand" ? actorId : null, "bank_confirmed", { line_id: line.id, how });
    return { state: "recorded", paymentId: typed.id, confirmed: true };
  }
  const actor = await actorFor(db, line, how === "hand" ? actorId : null);
  const { rows: [c] } = await db.query("SELECT id, name, erp_customer_id, assigned_manager_id FROM customers WHERE id = $1", [customerId]);
  if (!c || !actor) {
    await db.query("UPDATE bank_statement_lines SET pay_state = 'unspecified', pay_reason = 'unknown_payer', pay_customer_id = NULL, pay_checked_at = now() WHERE id = $1", [line.id]);
    return { state: "unspecified" };
  }
  const { rows: [p] } = await db.query(
    `INSERT INTO customer_payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, paid_at, pay_day, method, account_id,
       collected_by, sales_manager_id, note, source, bank_line_id, payer_match, created_by)
     VALUES ($1, $2, $3, $4, ($5::date + time '12:00') AT TIME ZONE 'Asia/Yerevan', $5, 'bank', $6, $7, $8, $9, 'bank', $10, $11, $7) RETURNING id`,
    [c.id, c.name, c.erp_customer_id ?? null, amount, day, line.account_id, actor, c.assigned_manager_id ?? null, lineNote(line), line.id, how]
  );
  await db.query(
    "UPDATE bank_statement_lines SET pay_state = 'recorded', pay_reason = NULL, pay_customer_id = $2, pay_checked_at = now(), pay_decided_by = $3 WHERE id = $1",
    [line.id, customerId, how === "hand" ? actorId : null]
  );
  await addEvent(db, p.id, how === "hand" ? actorId : null, "recorded_from_bank", { line_id: line.id, how });
  return { state: "recorded", paymentId: p.id };
}

const LINE_SQL = `SELECT l.*, a.kind AS account_kind, i.user_id AS import_user_id
                  FROM bank_statement_lines l JOIN cash_accounts a ON a.id = l.account_id LEFT JOIN bank_imports i ON i.id = l.import_id`;

/**
 * Look at every statement line not looked at yet: money in, AMD, from the cutover on, on a bank / card account. Runs right after an upload
 * and in the "payments-v2" job. Returns { recorded, confirmed, unspecified, skipped }.
 */
export async function recordBankLines(db = pool, { actorId = null } = {}) {
  const cutover = await getCutover(db);
  const stats = { recorded: 0, confirmed: 0, unspecified: 0, skipped: 0 };
  const { rows: todo } = await db.query("SELECT id FROM bank_statement_lines WHERE pay_checked_at IS NULL AND amount > 0 ORDER BY line_date, id");
  if (!todo.length) return stats;
  const index = await payerIndex(db);
  // one line per transaction, locked: an upload and the job looking at the same new lines at once never record one twice
  const client = await db.connect();
  try {
    for (const { id } of todo) {
      await client.query("BEGIN");
      try {
        const { rows: [line] } = await client.query(`${LINE_SQL} WHERE l.id = $1 AND l.pay_checked_at IS NULL FOR UPDATE OF l SKIP LOCKED`, [id]);
        if (line) stats[await checkLine(client, line, index, cutover, actorId)] += 1;
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    }
  } finally {
    client.release();
  }
  return stats;
}

// What one new line is: returns the stats key it counts under.
async function checkLine(db, line, index, cutover, actorId) {
  const candidate = line.currency === "AMD" && ymd(line.line_date) >= cutover && ["bank", "card"].includes(line.account_kind) && Math.round(Number(line.amount)) > 0;
  if (!candidate) {
    await db.query("UPDATE bank_statement_lines SET pay_checked_at = now() WHERE id = $1", [line.id]);
    return "skipped";
  }
  const who = identifyPayer(line, index);
  if (who.notCustomer) {
    await db.query("UPDATE bank_statement_lines SET pay_state = 'not_customer', pay_reason = NULL, pay_checked_at = now() WHERE id = $1", [line.id]);
    return "skipped";
  }
  if (!who.customerId) {
    await db.query(
      "UPDATE bank_statement_lines SET pay_state = 'unspecified', pay_reason = $2, pay_customer_id = $3, pay_checked_at = now() WHERE id = $1",
      [line.id, who.reason, who.suggestion ?? null]
    );
    return "unspecified";
  }
  const r = await attachLine(db, line, who.customerId, who.how, actorId);
  if (r.state !== "recorded") return "unspecified";
  return r.confirmed ? "confirmed" : "recorded";
}

async function remember(db, line, customerId, userId) {
  const key = payerKey(line.counterparty);
  if (!key) return;
  await db.query(
    `INSERT INTO bank_payers (payer_key, customer_id, payer_label, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (payer_key) DO UPDATE SET customer_id = EXCLUDED.customer_id, payer_label = EXCLUDED.payer_label, created_by = EXCLUDED.created_by, updated_at = now()`,
    [key, customerId, String(line.counterparty).slice(0, 200), userId]
  );
}

/**
 * The accountant's answer about a line waiting in Unspecified. action:
 *   customer      { customer_id, remember } -- it is this customer's payment (confirms the typed one or records it); remember = next time automatic
 *   not_customer  { remember }              -- not a customer payment (own transfer, loan, card settlement ...)
 *   separate                                -- "possible copy", but it is a separate payment: record it for the customer found
 *   duplicate                               -- "possible copy", and it is the same money: nothing is recorded
 *   reopen                                  -- a line marked not-a-customer / duplicate goes back to Unspecified
 * Returns { line, paymentId? } or { status, error }.
 */
export async function resolveLine(db, user, lineId, body) {
  const action = String(body?.action ?? "");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: [line] } = await client.query(`${LINE_SQL} WHERE l.id = $1 FOR UPDATE OF l`, [lineId]);
    const done = async (result) => {
      await client.query("COMMIT");
      return result;
    };
    const stop = async (status, error) => {
      await client.query("ROLLBACK");
      return { status, error };
    };
    if (!line) return stop(404, "Line not found");
    if (action === "reopen") {
      if (!["not_customer", "duplicate"].includes(line.pay_state)) return stop(409, "Only a line marked not-a-customer or duplicate can be reopened");
      await client.query("UPDATE bank_statement_lines SET pay_state = 'unspecified', pay_reason = 'unknown_payer', pay_copy_of = NULL, pay_decided_by = $2 WHERE id = $1", [line.id, user.id]);
      // the payer is no longer skipped by itself either
      const key = payerKey(line.counterparty);
      if (key) await client.query("DELETE FROM bank_payers WHERE payer_key = $1 AND customer_id IS NULL", [key]);
      return done({ line: { id: line.id, pay_state: "unspecified" } });
    }
    if (line.pay_state !== "unspecified") return stop(409, "This line is already decided");
    if (action === "not_customer") {
      await client.query("UPDATE bank_statement_lines SET pay_state = 'not_customer', pay_reason = NULL, pay_decided_by = $2 WHERE id = $1", [line.id, user.id]);
      if (body?.remember !== false) await remember(client, line, null, user.id);
      return done({ line: { id: line.id, pay_state: "not_customer" } });
    }
    if (action === "duplicate") {
      if (line.pay_reason !== "possible_copy") return stop(409, "Only a possible copy can be marked as a duplicate");
      await client.query("UPDATE bank_statement_lines SET pay_state = 'duplicate', pay_reason = NULL, pay_decided_by = $2 WHERE id = $1", [line.id, user.id]);
      return done({ line: { id: line.id, pay_state: "duplicate" } });
    }
    let customerId;
    if (action === "separate") {
      if (line.pay_reason !== "possible_copy" || !line.pay_customer_id) return stop(409, "Choose the customer of this line");
      customerId = line.pay_customer_id;
    } else if (action === "customer") {
      customerId = Number(body?.customer_id);
      if (!Number.isInteger(customerId)) return stop(400, "Choose the customer");
      const { rows } = await client.query("SELECT 1 FROM customers WHERE id = $1", [customerId]);
      if (!rows.length) return stop(400, "Customer not found");
    } else return stop(400, "Unknown action");
    const r = await attachLine(client, line, customerId, "hand", user.id, { checkCopy: false });
    if (r.state !== "recorded") return stop(409, "The line could not be recorded");
    if (action === "customer" && body?.remember !== false) await remember(client, line, customerId, user.id);
    return done({ line: { id: line.id, pay_state: "recorded" }, paymentId: r.paymentId, confirmed: Boolean(r.confirmed) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A bank / card payment typed by hand: { customer_id, amount, day, account_id, method, note, client_ref, separate }.
 * Refused (409, with the look-alikes) when the customer already has a bank / card payment of the same amount within 5 days, until
 * `separate: true` says it is another payment. Returns { payment, existing? } or { status, error, duplicates? }.
 */
export async function recordByHand(db, user, body) {
  const customerId = Number(body?.customer_id);
  const amount = Math.round(Number(body?.amount));
  const day = String(body?.day ?? "");
  const accountId = Number(body?.account_id);
  const method = body?.method === "card" ? "card" : "bank";
  const note = String(body?.note ?? "").trim().slice(0, 300) || null;
  const clientRef = typeof body?.client_ref === "string" && body.client_ref.length <= 80 ? body.client_ref : null;
  if (!Number.isInteger(customerId)) return { status: 400, error: "Choose the customer" };
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e11) return { status: 400, error: "Enter the amount" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { status: 400, error: "Choose the date" };
  const cutover = await getCutover(db);
  const { rows: [{ today }] } = await db.query("SELECT to_char((now() AT TIME ZONE 'Asia/Yerevan')::date, 'YYYY-MM-DD') AS today");
  if (day < cutover) return { status: 400, error: `Payments before ${cutover} stay in the old module` };
  if (day > today) return { status: 400, error: "The date is in the future" };
  if (clientRef) {
    const { rows: [same] } = await db.query("SELECT * FROM customer_payments WHERE created_by = $1 AND client_ref = $2", [user.id, clientRef]);
    if (same) return { payment: same, existing: true };
  }
  const [{ rows: [c] }, { rows: [acc] }] = await Promise.all([
    db.query("SELECT id, name, erp_customer_id, assigned_manager_id FROM customers WHERE id = $1", [customerId]),
    db.query("SELECT id, kind, active FROM cash_accounts WHERE id = $1", [accountId]),
  ]);
  if (!c) return { status: 400, error: "Customer not found" };
  if (!acc || !["bank", "card"].includes(acc.kind) || !acc.active) return { status: 400, error: "Choose the bank account" };
  if (body?.separate !== true) {
    const { rows: dups } = await db.query(
      `SELECT p.id, to_char(p.pay_day, 'YYYY-MM-DD') AS day, p.amount_amd::float8 AS amount, p.source, p.method, a.name AS account
       FROM customer_payments p LEFT JOIN cash_accounts a ON a.id = p.account_id
       WHERE p.customer_id = $1 AND p.voided_at IS NULL AND p.method IN ('bank', 'card') AND p.amount_amd = $2 AND abs(p.pay_day - $3::date) <= $4
       ORDER BY abs(p.pay_day - $3::date), p.id LIMIT 5`,
      [customerId, amount, day, SAME_DAYS]
    );
    if (dups.length) return { status: 409, error: "This payment looks already recorded", duplicates: dups };
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: [p] } = await client.query(
      `INSERT INTO customer_payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, paid_at, pay_day, method, account_id,
         collected_by, sales_manager_id, note, source, payer_match, client_ref, created_by)
       VALUES ($1, $2, $3, $4, ($5::date + time '12:00') AT TIME ZONE 'Asia/Yerevan', $5, $6, $7, $8, $9, $10, 'app', 'typed', $11, $8) RETURNING *`,
      [c.id, c.name, c.erp_customer_id ?? null, amount, day, method, accountId, user.id, c.assigned_manager_id ?? null, note, clientRef]
    );
    await addEvent(client, p.id, user.id, "recorded_by_hand", { method, separate: body?.separate === true });
    // a statement line already waiting for exactly this customer and amount (suggested, or a possible copy of it) is this payment's proof
    const { rows: waiting } = await client.query(
      `SELECT id FROM bank_statement_lines WHERE pay_state = 'unspecified' AND pay_reason IN ('ambiguous', 'unknown_payer') AND pay_customer_id = $1
         AND account_id = $2 AND round(amount) = $3 AND abs(line_date - $4::date) <= $5 ORDER BY abs(line_date - $4::date), id LIMIT 2`,
      [customerId, accountId, amount, day, SAME_DAYS]
    );
    let payment = p;
    if (waiting.length === 1) {
      ({ rows: [payment] } = await client.query("UPDATE customer_payments SET bank_line_id = $2 WHERE id = $1 RETURNING *", [p.id, waiting[0].id]));
      await client.query("UPDATE bank_statement_lines SET pay_state = 'recorded', pay_reason = NULL, pay_decided_by = $2 WHERE id = $1", [waiting[0].id, user.id]);
      await addEvent(client, p.id, user.id, "bank_confirmed", { line_id: waiting[0].id, how: "typed" });
    }
    await client.query("COMMIT");
    return { payment };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505" && clientRef) {
      const { rows: [same] } = await db.query("SELECT * FROM customer_payments WHERE created_by = $1 AND client_ref = $2", [user.id, clientRef]);
      if (same) return { payment: same, existing: true };
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A bank / card payment found for the wrong customer: it moves to the right one (with a reason). Its Excel booking is undone (the new
 * customer's rows are looked for again) and the payer is remembered for the new customer. Returns { payment } or { status, error }.
 */
export async function changeCustomer(db, user, paymentId, body) {
  const customerId = Number(body?.customer_id);
  const reason = String(body?.reason ?? "").trim().slice(0, 300);
  if (!Number.isInteger(customerId)) return { status: 400, error: "Choose the customer" };
  if (reason.length < 3) return { status: 400, error: "Write why the customer changes" };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: [p] } = await client.query("SELECT * FROM customer_payments WHERE id = $1 FOR UPDATE", [paymentId]);
    const stop = async (status, error) => {
      await client.query("ROLLBACK");
      return { status, error };
    };
    if (!p) return stop(404, "Payment not found");
    if (p.voided_at) return stop(409, "The payment is voided");
    if (!["bank", "card"].includes(p.method)) return stop(409, "Only a bank or card payment changes its customer here");
    if (p.customer_id === customerId) return stop(409, "It is already this customer's payment");
    const { rows: [c] } = await client.query("SELECT id, name, erp_customer_id, assigned_manager_id FROM customers WHERE id = $1", [customerId]);
    if (!c) return stop(400, "Customer not found");
    await client.query("DELETE FROM payment_book_links WHERE payment_id = $1", [p.id]);
    await client.query("DELETE FROM payment_allocations WHERE payment_id = $1", [p.id]);
    const { rows: [payment] } = await client.query(
      `UPDATE customer_payments SET customer_id = $2, customer_name_snapshot = $3, erp_customer_id_snapshot = $4, sales_manager_id = $5,
         books_state = 'open', books_note = NULL, payer_match = 'hand', updated_at = now() WHERE id = $1 RETURNING *`,
      [p.id, c.id, c.name, c.erp_customer_id ?? null, c.assigned_manager_id ?? null]
    );
    await addEvent(client, p.id, user.id, "customer_changed", { from: p.customer_id, from_name: p.customer_name_snapshot, to: c.id, reason });
    if (p.bank_line_id) {
      await client.query("UPDATE bank_statement_lines SET pay_customer_id = $2 WHERE id = $1", [p.bank_line_id, c.id]);
      const { rows: [line] } = await client.query("SELECT counterparty FROM bank_statement_lines WHERE id = $1", [p.bank_line_id]);
      if (line) await remember(client, line, c.id, user.id);
    }
    await client.query("COMMIT");
    return { payment };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
