// The request card (owner, 2026-11-08: "All requests ... should come also with push notification so that user can open it and choose
// approve or deny"). One place that says, for each kind of request waiting for a decision, WHO may decide it -- built only from the
// capability functions of shared/roles.js (the same functions each kind's own approve / reject endpoint checks), never role arrays.
// No SQL and no req/res here (docs/architecture-roadmap.md section 4).
import {
  canApproveReturns,
  canReviewCustomerEdits,
  canReviewPayments,
  isCashflowManagement,
  canPlanForOthers,
  canReviewPlan,
  canApproveBonusRewards,
  canConfirmOrders,
  canApproveCompetitorBrands,
} from "../../shared/roles.js";
import { canApproveDiscountRole } from "../../orders/discountPolicy.js";
import { approvalBlock } from "../../money/cashRoute.js";
import { pendingRequests } from "./queries.js";

// The kinds, in the order the Requests list groups them.
export const REQUEST_KINDS = ["discount", "return", "customer_edit", "payment", "cashflow", "visit_plan", "perf_plan", "bonus_claim", "competitor_brand"];

export const isRequestKind = (kind) => REQUEST_KINDS.includes(kind);

// facts: what a kind's rule needs to know about this one request (filled by queries.js):
//   discount    -> belowCost, belowLanding (a line below net / landing cost narrows who may approve)
//   perf_plan   -> submittedByRole (the accountant reviews only a sales director's plan)
//   bonus_claim -> claimantId (nobody approves their own reward)
//   payment     -> payment { status, pending_handoff_id, created_by, holder_role }, accountantDirect (where the cash is decides who may APPROVE: mayApprove)
export function mayDecide(kind, user, facts = {}) {
  if (!user) return false;
  switch (kind) {
    case "discount":
      return canConfirmOrders(user.role) && canApproveDiscountRole(user.role, Boolean(facts.belowCost), Boolean(facts.belowLanding));
    case "return":
      return canApproveReturns(user.role);
    case "customer_edit":
      return canReviewCustomerEdits(user.role);
    case "payment":
      // may decide = may at least refuse it; whether Approve is offered too is mayApprove below (one route for cash)
      return canReviewPayments(user.role);
    case "cashflow":
      return isCashflowManagement(user.role);
    case "visit_plan":
      return canPlanForOthers(user.role);
    case "perf_plan":
      return canReviewPlan(user.role, facts.submittedByRole);
    case "bonus_claim":
      return canApproveBonusRewards(user.role) && user.id !== facts.claimantId;
    case "competitor_brand":
      return canApproveCompetitorBrands(user.role);
    default:
      return false;
  }
}

// Approve, next to Deny, on a request this person may decide. Only a payment differs: cash that was not handed over yet is approved by
// its hand-over (money/cashRoute.js approvalBlock; admin and the CEO always), but a wrong record can still be refused.
export function mayApprove(kind, user, facts = {}) {
  if (!mayDecide(kind, user, facts)) return false;
  if (kind !== "payment" || !facts.payment) return true;
  return !approvalBlock(facts.payment, user, { accountantDirect: Boolean(facts.accountantDirect) });
}
// A payment inside a hand-over waiting for its receiver can be neither approved nor refused until that is decided (the card says so).
export const paymentInHandover = (kind, facts = {}) => kind === "payment" && Boolean(facts.payment?.pending_handoff_id);

// Who may open a card: whoever may decide it, and the person who asked (to see the result).
export function mayView(kind, user, request) {
  return mayDecide(kind, user, request.facts) || user.id === request.requested_by_id;
}

// The address a push opens: the full-screen card of that one request.
export const requestUrl = (kind, id) => `/#/requests/${kind}/${id}`;

// A denial's reason: required, trimmed, at most 500 characters. "" = missing.
export function cleanReason(value) {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

// Facts under which a kind's rule is at its most permissive: "could this role decide ANY request of this kind?" (which kinds to read).
const ANY_FACTS = { belowCost: false, belowLanding: false, submittedByRole: "sales_director", claimantId: -1 };
export const decidableKinds = (user) => REQUEST_KINDS.filter((kind) => mayDecide(kind, user, ANY_FACTS));

// Every request waiting that THIS person may decide, newest first (the Requests list and its badge).
export async function decidableRequests(db, user) {
  const kinds = decidableKinds(user);
  if (!kinds.length) return [];
  // only a role that decides SOME discounts (the operations director: not below net cost) needs each order's cost check
  const discountNeedsCheck = !mayDecide("discount", user, { belowCost: true, belowLanding: true });
  const rows = await pendingRequests(db, kinds, { needsFacts: (kind) => kind !== "discount" || discountNeedsCheck });
  return rows
    .filter((r) => mayDecide(r.kind, user, r.facts))
    .sort((a, b) => new Date(b.requested_at ?? 0) - new Date(a.requested_at ?? 0));
}
