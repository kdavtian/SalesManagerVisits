// One route for cash (owner, 2026-11-23): rep -> sales director -> accountant, a rep may hand straight to the accountant, and nothing
// else. This file holds the one rule both the Approve button and the server use: may THIS person approve THIS payment now?
//   - never while it is inside a hand-over waiting for its receiver;
//   - admin and the CEO: always ("CEO can do all"): approving = "I received this money";
//   - anybody who reviews payments: once the cash is with an accountant (the route already ran; a correction after a reopen);
//   - the accountant, cash not handed over yet: only a payment she entered herself (money paid at the office, owner 2026-11-20), or any
//     when App configuration switches "Accountant approves without a hand-over" back on (app_settings.accountant_direct_approval).
import { pool } from "../db/pool.js";
import { canReviewPayments, receivesCashWithoutHandover } from "../shared/roles.js";

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
