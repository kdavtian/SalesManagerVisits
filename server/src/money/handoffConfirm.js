// Confirming a cash handover, inside the caller's transaction: the handover is marked confirmed, a rep's first hop makes its cash sheet,
// custody moves to the recipient, the accountant's confirmation approves the payments, a short count is kept as a shortfall. One place for
// the person's confirm (routes/cashHandoffs.js) and the Excel "Balance" record (excelBalanceHandoffs.js), so both do exactly the same.
// `handoff` is the row read FOR UPDATE and still pending; the caller notifies after its COMMIT.
import { isTerminalHandoffRole } from "../shared/roles.js";
import { createCashSheet } from "./cashSheets.js";

const getUser = async (id, db) => (await db.query("SELECT id, name, role, position FROM users WHERE id = $1", [id])).rows[0] ?? null;

export async function confirmHandoffInTx(client, handoff, { confirmerId, counted = null, discrepancyNote = null, fromExcel = false }) {
  const expected = Math.round(Number(handoff.amount_amd));
  const discrepancy = counted !== null && Math.round(counted) !== expected;
  const recipient = await getUser(handoff.to_user_id, client);
  const sender = await getUser(handoff.from_user_id, client);
  await client.query(
    `UPDATE cash_handoffs SET status = 'confirmed', confirmed_by = $1, confirmed_at = now(), counted_amd = $3, discrepancy_note = $4, from_excel = from_excel OR $5 WHERE id = $2`,
    [confirmerId, handoff.id, counted ?? expected, discrepancy ? discrepancyNote : null, fromExcel]
  );
  // A rep's cash (the first hop) makes the daily cash sheet that replaces the director's paper list; the bot posts it to the accountant.
  if (sender?.role === "sales_manager") {
    const sheetId = await createCashSheet(client, handoff, { directorId: confirmerId, countedAmd: counted ?? expected });
    // already in the Excel (that is where it came from): the sheet needs no recording
    if (fromExcel && sheetId) await client.query("UPDATE cash_sheets SET recorded_at = now(), recorded_auto = true WHERE id = $1", [sheetId]);
  }

  // Custody moves; the in-flight lock clears either way.
  await client.query(
    `UPDATE payments SET current_holder_id = $1, pending_handoff_id = NULL
     WHERE id IN (SELECT payment_id FROM cash_handoff_items WHERE handoff_id = $2)`,
    [handoff.to_user_id, handoff.id]
  );

  if (isTerminalHandoffRole(recipient.role)) {
    // The accountant is always the last stage, so their confirmation is
    // the moment the money's journey is complete -- which is exactly what
    // payments.status = 'approved' has always meant. Reports, exports and
    // Team Performance therefore keep working unchanged.
    const { rows: terminal } = await client.query(
      `UPDATE payments SET status = 'approved', approved_by = $1, approved_at = now(),
              rejected_by = NULL, rejected_at = NULL, rejection_reason = NULL
       WHERE id IN (SELECT payment_id FROM cash_handoff_items WHERE handoff_id = $2)
         AND status = 'pending'
       RETURNING id`,
      [confirmerId, handoff.id]
    );
    for (const row of terminal) {
      await client.query(
        `INSERT INTO payment_status_history (payment_id, old_status, new_status, reason, changed_by)
         VALUES ($1, 'pending', 'approved', $2, $3)`,
        [row.id, fromExcel ? `Cash handoff #${handoff.id} recorded in the Excel (Balance)` : `Cash handoff #${handoff.id} confirmed`, confirmerId]
      );
    }
    // Already approved from the Excel, but the notes only reach the accountant now: the person who received them is recorded.
    await client.query(
      `UPDATE payments SET approved_by = $1, approved_at = COALESCE(approved_at, now())
       WHERE id IN (SELECT payment_id FROM cash_handoff_items WHERE handoff_id = $2) AND status = 'approved' AND approved_from_erp AND approved_by IS NULL`,
      [confirmerId, handoff.id]
    );
  }

  // Owner's answer 6 (2026-11-02): counted LESS than the payments -> the difference stays on the sender's line until it is paid in or
  // written off (cash_shortfalls). More than expected is only the note, as before.
  const shortBy = counted !== null ? expected - Math.round(counted) : 0;
  if (shortBy > 0) {
    await client.query("INSERT INTO cash_shortfalls (handoff_id, user_id, amount_amd, note) VALUES ($1, $2, $3, $4)", [handoff.id, handoff.from_user_id, shortBy, discrepancyNote]);
  }
  return { recipient, sender, shortBy, discrepancy, expected };
}
