// Until the new payment screens are switched on, the team still records payments in the old module. Everything it records from the cutover
// date on (owner's answer 1: 1 November 2026) is copied here, and kept in step (who holds the cash, rejected), so the new books track and its
// reports already run on real data. Old payments before the cutover stay in the old module as the archive (owner: "start fresh").
//
// Old status -> the cash track:
//   held by the rep (or nobody)                      -> collected
//   held by the sales director / CEO / ops / admin   -> counted
//   held by the accountant / on the office desk, or approved by a person  -> received
//   rejected                                          -> voided ("Rejected in the old module")
//   deleted in the old module                         -> voided ("Deleted in the old module")
// A copy someone voided by hand is never brought back.
import { pool } from "../../db/pool.js";
import { addEvent, getCutover } from "./service.js";
import { deskMap } from "./desks.js";

const COUNTED_ROLES = new Set(["sales_director", "ceo", "operations_director", "admin"]);

export function cashStateFromOld(old) {
  // approved by a person (also an Excel-approved payment whose notes the accountant then received in a hand-over: approved_by is set)
  if (old.status === "approved" && (old.approved_by || !old.approved_from_erp)) return "received";
  if (old.holder_role === "accountant") return "received";
  // on the office desk (a desk an accountant holds, e.g. the CEO who shares it): the company has it (owner, 2026-11-02)
  if (old.holder_on_office_desk) return "received";
  if (COUNTED_ROLES.has(old.holder_role)) return "counted";
  return "collected";
}

export async function runBridge(db = pool) {
  const cutover = await getCutover(db);
  const stats = { added: 0, updated: 0, voided: 0 };
  const { rows: old } = await db.query(
    `SELECT p.*, h.role AS holder_role, (p.payment_date AT TIME ZONE 'Asia/Yerevan')::date AS day, c.erp_customer_id AS customer_erp
     FROM payments p LEFT JOIN users h ON h.id = p.current_holder_id LEFT JOIN customers c ON c.id = p.customer_id
     WHERE (p.payment_date AT TIME ZONE 'Asia/Yerevan')::date >= $1::date`,
    [cutover]
  );
  const { rows: copies } = await db.query("SELECT * FROM customer_payments WHERE source = 'bridge'");
  const copyOf = new Map(copies.filter((c) => c.legacy_payment_id).map((c) => [c.legacy_payment_id, c]));
  const desks = await deskMap(db);
  const deskOf = (userId) => desks.get(userId) ?? null;
  const { rows: officeRows } = await db.query(
    "SELECT DISTINCT h.account_id FROM cash_desk_holders h JOIN users u ON u.id = h.user_id WHERE u.role = 'accountant'"
  );
  const officeDesks = new Set(officeRows.map((r) => r.account_id));

  for (const o of old) {
    const holder = o.current_holder_id ?? o.sales_manager_id;
    const state = cashStateFromOld({ ...o, holder_on_office_desk: officeDesks.has(deskOf(holder)) });
    const copy = copyOf.get(o.id);
    const rejected = o.status === "rejected";
    if (!copy) {
      const { rows } = await db.query(
        `INSERT INTO customer_payments (customer_id, customer_name_snapshot, erp_customer_id_snapshot, amount_amd, paid_at, pay_day, method, account_id,
           collected_by, sales_manager_id, cash_state, holder_id, voided_at, void_reason, note, source, legacy_payment_id, created_by, created_at)
         VALUES ($1, $2, $3, round($4), $5, $6, 'cash', $7, $8, $8, $9, $10, $11, $12, $13, 'bridge', $14, $15, $16) RETURNING id`,
        [
          o.customer_id, o.customer_name_snapshot, o.erp_customer_id_snapshot ?? o.customer_erp ?? null, o.amount_amd, o.payment_date, o.day,
          deskOf(holder), o.sales_manager_id, state, holder,
          rejected ? o.rejected_at ?? new Date() : null, rejected ? `Rejected in the old module${o.rejection_reason ? `: ${o.rejection_reason}` : ""}` : null,
          o.note, o.id, o.created_by, o.created_at,
        ]
      );
      await addEvent(db, rows[0].id, null, "copied_from_old", { legacy_payment_id: o.id, status: o.status, cash_state: state });
      stats.added += 1;
      continue;
    }
    if (copy.voided_by) continue; // voided by a person here: stays voided
    if (rejected && !copy.voided_at) {
      await db.query("UPDATE customer_payments SET voided_at = now(), void_reason = $2, updated_at = now() WHERE id = $1", [copy.id, `Rejected in the old module${o.rejection_reason ? `: ${o.rejection_reason}` : ""}`]);
      await db.query("DELETE FROM payment_book_links WHERE payment_id = $1", [copy.id]);
      await addEvent(db, copy.id, null, "voided", { reason: "rejected_in_old_module" });
      stats.voided += 1;
      continue;
    }
    if (!rejected && (copy.cash_state !== state || copy.holder_id !== holder)) {
      await db.query("UPDATE customer_payments SET cash_state = $2, holder_id = $3, account_id = $4, updated_at = now() WHERE id = $1", [copy.id, state, holder, deskOf(holder)]);
      await addEvent(db, copy.id, null, "cash_moved", { from: copy.cash_state, to: state, holder_id: holder });
      stats.updated += 1;
    } else if (!rejected && !copy.voided_at && copy.account_id !== deskOf(holder) && deskOf(holder)) {
      // the holder got a desk (or another one) since: the cash is on it
      await db.query("UPDATE customer_payments SET account_id = $2, updated_at = now() WHERE id = $1", [copy.id, deskOf(holder)]);
      stats.updated += 1;
    }
  }

  // deleted in the old module: the link to it is gone (ON DELETE SET NULL)
  const { rows: orphans } = await db.query("SELECT id FROM customer_payments WHERE source = 'bridge' AND legacy_payment_id IS NULL AND voided_at IS NULL");
  for (const { id } of orphans) {
    await db.query("UPDATE customer_payments SET voided_at = now(), void_reason = 'Deleted in the old module', updated_at = now() WHERE id = $1", [id]);
    await db.query("DELETE FROM payment_book_links WHERE payment_id = $1", [id]);
    await addEvent(db, id, null, "voided", { reason: "deleted_in_old_module" });
    stats.voided += 1;
  }
  return stats;
}
