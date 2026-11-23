// Where is the cash of a payment right now? ONE answer for every screen (owner, 2026-11-23: "status must be clear where is cash right
// now"). Pure: the server puts the result on each payment it sends (`cash_place`), the screens only draw it (cashPlaceChip.js), so the
// Payments list, the payment sheet, the customer's payments, the request card and the money ledger can never disagree.
//
//   rejected       the record was refused: no cash is tracked
//   on_the_way     inside a hand-over waiting for its receiver to count it     -> `to` = the receiver
//   with_rep       still with the person who collected it (a sales rep, a driver) -> `name` = who holds it
//   with_director  counted and held by a sales director / CEO / ops / admin       -> `name` = who holds it
//   office         received: with an accountant / on the office desk, or approved by a person who then holds it (`direct`: that
//                  person is not at the office desk, e.g. the CEO took it without a hand-over -> the mark names them)
//
// The Excel is the second, independent question ("is it in the books?") and stays its own mark next to this one.
const OFFICE_ROLES = ["accountant"];
const COUNTED_ROLES = ["sales_director", "ceo", "operations_director", "admin"];

/**
 * p: { status, approved_by, approved_from_erp, pending_handoff_id, holder_role, holder_name, handoff_to_name, on_office_desk }
 * Returns { place, name, to }.
 */
export function cashPlace(p) {
  const name = p.holder_name ?? null;
  if (p.status === "rejected") return { place: "rejected", name: null, to: null };
  // approved by a person = that person received the money (the accountant's confirmed hand-over, or a direct approval). A payment only
  // the Excel approved (approved_from_erp, nobody's approved_by) is still wherever its holder is: the notes did not move.
  const received = p.status === "approved" && (Boolean(p.approved_by) || !p.approved_from_erp);
  const atDesk = OFFICE_ROLES.includes(p.holder_role) || Boolean(p.on_office_desk);
  // `direct`: received by a person who is not at the office desk (admin or the CEO approved it directly): the mark names that person
  if (received || atDesk) return { place: "office", name, to: null, ...(atDesk || !name ? {} : { direct: true }) };
  if (p.pending_handoff_id) return { place: "on_the_way", name, to: p.handoff_to_name ?? null };
  return { place: COUNTED_ROLES.includes(p.holder_role) ? "with_director" : "with_rep", name, to: null };
}

// The cash track of the copied payment (payments2/bridge.js) is the same answer in three words; a hand-over still waiting has not moved
// the cash yet, so it counts where its sender is.
export function cashStateOf(p) {
  const { place } = cashPlace({ ...p, pending_handoff_id: null });
  return place === "office" ? "received" : place === "with_director" ? "counted" : "collected";
}

export const CASH_PLACES = ["with_rep", "on_the_way", "with_director", "office", "rejected"];
