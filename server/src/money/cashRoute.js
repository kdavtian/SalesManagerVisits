// One route for cash (owner, 2026-11-23): rep -> sales director -> accountant, a rep may hand straight to the accountant, and nothing
// else. This file holds the one rule both the Approve button and the server use: may THIS person approve THIS payment now?
//   - never while it is inside a hand-over waiting for its receiver;
//   - admin and the CEO: always ("CEO can do all"): approving = "I received this money";
//   - anybody who reviews payments: once the cash is with an accountant (the route already ran; a correction after a reopen);
//   - the accountant, cash not handed over yet: only a payment she entered herself (money paid at the office, owner 2026-11-20), or any
//     when App configuration switches "Accountant approves without a hand-over" back on (app_settings.accountant_direct_approval).
import { pool } from "../db/pool.js";
import { canReviewPayments, canVoidCountedPayment, receivesCashWithoutHandover } from "../shared/roles.js";

export async function getAccountantDirectApproval(db = pool) {
  const { rows } = await db.query("SELECT accountant_direct_approval FROM app_settings WHERE id = 1");
  return rows[0]?.accountant_direct_approval ?? false;
}

export async function setAccountantDirectApproval(enabled) {
  const { rows } = await pool.query(
    `INSERT INTO app_settings (id, accountant_direct_approval) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET accountant_direct_approval = EXCLUDED.accountant_direct_approval RETURNING accountant_direct_approval`,
    [enabled]
  );
  return rows[0].accountant_direct_approval;
}

export const NOT_HANDED_OVER = "This cash was not handed over yet: it is approved when its hand-over is confirmed";
export const IN_HANDOVER = "This payment is part of a cash handoff awaiting confirmation -- resolve that handoff first";

/**
 * payment: { status, pending_handoff_id, created_by, holder_role }   user: { id, role }
 * Returns null when the user may approve it, else the reason (shown to the person).
 */
export function approvalBlock(payment, user, { accountantDirect = false } = {}) {
  if (!canReviewPayments(user.role)) return "Not allowed to approve payments";
  if (payment.status !== "pending") return "Only a pending payment can be approved";
  if (payment.pending_handoff_id) return IN_HANDOVER;
  if (receivesCashWithoutHandover(user.role)) return null;
  if (payment.holder_role === "accountant") return null;
  if (user.role === "accountant" && (accountantDirect || payment.created_by === user.id)) return null;
  return NOT_HANDED_OVER;
}

// Approving cash that is not with an accountant yet means the approver received it: it lands in their hands.
export function approverTakesCash(payment, user) {
  return payment.holder_role !== "accountant" && (receivesCashWithoutHandover(user.role) || user.role === "accountant");
}

// Rejecting or reopening a payment (improvement plan 0.16, owner 2026-11-28). A payment still only in its collector's hands: any payment
// reviewer, as before. Cash someone else counted or received, or a payment approved at least once (cashCustody.js CASH_COUNTED_SQL ->
// payment.cash_counted): only admin / CEO, with a reason of 3+ letters -- one reviewer must not take counted cash out of the chain alone.
export const COUNTED_NEEDS_MANAGEMENT = "This cash was already counted or received (or approved): only admin or the CEO can reject or reopen it";
export function cashDecisionBlock(payment, user) {
  if (!canReviewPayments(user.role)) return "Not allowed to review payments";
  if (payment.cash_counted && !canVoidCountedPayment(user.role)) return COUNTED_NEEDS_MANAGEMENT;
  return null;
}
// The Reject button (pending, not inside a waiting hand-over) and the Reopen button (approved / rejected), as the server will accept them.
export const mayRejectPayment = (payment, user) => payment.status === "pending" && !payment.pending_handoff_id && !cashDecisionBlock(payment, user);
export const mayReopenPayment = (payment, user) => payment.status !== "pending" && !cashDecisionBlock(payment, user);

// Closing a counting shortfall (improvement plan 0.15, owner 2026-11-28). shortfall: { user_id (who owes it), counted_by (who confirmed the
// hand-over), to_user_id (whom it was addressed to) }. Nobody closes their own; "paid in" by the person who counted it (the receiver) or
// admin / CEO, always with a note; "written off" by admin / CEO only, with the reason. Returns null, or { status, error }.
export function shortfallCloseBlock(shortfall, user, how, note) {
  if (how !== "paid" && how !== "written_off") return { status: 400, error: "how must be paid or written_off" };
  if (shortfall.user_id === user.id) return { status: 403, error: "You cannot close your own shortfall" };
  const management = canVoidCountedPayment(user.role);
  if (how === "written_off" && !management) return { status: 403, error: "Only admin or CEO can write a shortfall off" };
  if (how === "paid" && !management && user.id !== shortfall.counted_by && user.id !== shortfall.to_user_id) {
    return { status: 403, error: "Only the person who counted this hand-over, admin or the CEO can close it" };
  }
  if (!note || note.length < 3) return { status: 400, error: how === "paid" ? "Write how the missing money was paid in" : "Write why it is written off" };
  return null;
}
// The Paid in / Write off buttons on a shortfall card, as the server will accept them (note checked when saving).
export const mayCloseShortfall = (shortfall, user, how) => !shortfallCloseBlock(shortfall, user, how, "ok!");
