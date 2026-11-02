// Shared rules of the redesigned payments (owner, 2026-11-02): the cutover date, the history trail, and voiding.
import { pool } from "../../db/pool.js";
import { canVoidCountedPayment } from "../../shared/roles.js";

export async function getCutover(db = pool) {
  const { rows } = await db.query("SELECT to_char(payments_cutover, 'YYYY-MM-DD') AS d FROM app_settings WHERE id = 1");
  return rows[0]?.d ?? "2026-11-01";
}

export async function isLive(db = pool) {
  const { rows } = await db.query("SELECT payments_v2_live FROM app_settings WHERE id = 1");
  return Boolean(rows[0]?.payments_v2_live);
}

export function addEvent(db, paymentId, actorId, kind, detail = {}) {
  return db.query("INSERT INTO customer_payment_events (payment_id, actor_id, kind, detail) VALUES ($1, $2, $3, $4)", [paymentId, actorId, kind, JSON.stringify(detail)]);
}

/** The cash desk (cash account) a person holds, or null. */
export async function cashDeskOf(db, userId) {
  if (!userId) return null;
  const { rows } = await db.query("SELECT id FROM cash_accounts WHERE holder_user_id = $1 AND kind = 'cash' AND active ORDER BY sort_order, id LIMIT 1", [userId]);
  return rows[0]?.id ?? null;
}

/**
 * Void a payment (a mistake): it stays in the history with the reason, it no longer counts anywhere, and the Excel rows it used are free
 * again. Owner's answer 7: once the cash is counted (or for a card / bank payment), only admin and CEO; before that, the person who took
 * it may fix their own mistake while the cash is still with them.
 * Returns { payment } or { status, error }.
 */
export async function voidPayment(db, user, paymentId, reasonRaw) {
  const reason = String(reasonRaw ?? "").trim().slice(0, 300);
  if (reason.length < 3) return { status: 400, error: "Write why the payment is voided" };
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM customer_payments WHERE id = $1 FOR UPDATE", [paymentId]);
    const p = rows[0];
    if (!p) {
      await client.query("ROLLBACK");
      return { status: 404, error: "Payment not found" };
    }
    if (p.voided_at) {
      await client.query("ROLLBACK");
      return { status: 409, error: "Already voided" };
    }
    const ownStillHeld = p.method === "cash" && p.cash_state === "collected" && p.collected_by === user.id && p.holder_id === user.id;
    if (!canVoidCountedPayment(user.role) && !ownStillHeld) {
      await client.query("ROLLBACK");
      return { status: 403, error: "Only admin or CEO can void a payment once its cash is counted" };
    }
    await client.query("DELETE FROM payment_book_links WHERE payment_id = $1", [p.id]);
    await client.query("DELETE FROM payment_allocations WHERE payment_id = $1", [p.id]);
    const { rows: done } = await client.query(
      `UPDATE customer_payments SET voided_at = now(), voided_by = $2, void_reason = $3, books_state = 'open', books_note = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [p.id, user.id, reason]
    );
    await addEvent(client, p.id, user.id, "voided", { reason });
    await client.query("COMMIT");
    return { payment: done[0] };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
