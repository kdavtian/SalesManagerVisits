// Pushes of the request card (owner, 2026-11-08):
//  - a new request -> EVERY person allowed to decide it (rules.js mayDecide), one notification each, opening the request's card;
//  - a decision    -> the person who asked hears the result (approved / denied + the reason), and the other approvers' unread
//    notifications of that request are marked read ("the first one who decides closes it for the others").
// Both never throw: a failed push must not undo or fail the decision that caused it (same rule as shared/notifications.js).
import { pool } from "../../db/pool.js";
import { notifyUser } from "../../shared/notifications.js";
import { bullets } from "../../utils/bullets.js";
import { mayDecide, requestUrl } from "./rules.js";
import { activeUsers, closeRequestNotifications, loadRequest, userName } from "./queries.js";

// Armenian names of the kinds, for push titles (pushes are Armenian-first like every other server notification).
export const KIND_TITLE_HY = {
  discount: "Պատվերի զեղչ / գին",
  return: "Վերադարձ",
  cancel: "Պատվերի չեղարկում",
  customer_edit: "Հաճախորդի քարտի փոփոխություն",
  payment: "Վճարում",
  cashflow: "Դրամարկղի գրառման փոփոխություն",
  visit_plan: "Այցելությունների պլան",
  perf_plan: "Աշխատանքային պլան",
  bonus_claim: "Բոնուսի պահանջ",
};

export const amdText = (v) => `${Math.round(Number(v) || 0).toLocaleString("en-US")} դր`;

// lines: the facts of the request as short "label: value" bullets (null ones are left out).
// onlyThese(user): an extra narrowing a kind keeps from before (payments page only the accountant, see PAYMENT_NOTIFY_ROLES).
export async function notifyApprovers({ kind, id, type = "approval_request", titleKind = kind, lines = [], requesterId = null, facts = {}, onlyThese = () => true }) {
  try {
    const users = await activeUsers(pool);
    const approvers = users.filter((u) => u.id !== requesterId && mayDecide(kind, u, facts) && onlyThese(u));
    const requester = await userName(pool, requesterId);
    const body = bullets([...lines, requester ? `Ով է խնդրում՝ ${requester}` : null]);
    await Promise.all(
      approvers.map((u) => notifyUser(u.id, type, { title: `Սպասում է Ձեր որոշմանը՝ ${KIND_TITLE_HY[titleKind] ?? KIND_TITLE_HY[kind]}`, body, url: requestUrl(kind, id) }))
    );
    return approvers.map((u) => u.id);
  } catch (err) {
    console.error(`Request notification (${kind} #${id}) failed:`, err);
    return [];
  }
}

export async function notifyDecision({ kind, id, deciderId, requesterId, approved, reason = null, type = "approval_result", titleKind = kind, lines = [] }) {
  try {
    const url = requestUrl(kind, id);
    await closeRequestNotifications(pool, url, deciderId);
    if (!requesterId || requesterId === deciderId) return;
    const decider = await userName(pool, deciderId);
    await notifyUser(requesterId, type, {
      title: `${KIND_TITLE_HY[titleKind] ?? KIND_TITLE_HY[kind]}՝ ${approved ? "հաստատվեց" : "մերժվեց"}`,
      body: bullets([...lines, decider ? `${approved ? "Հաստատեց" : "Մերժեց"}՝ ${decider}` : null, !approved && reason ? `Պատճառ՝ ${reason}` : null]),
      url,
    });
  } catch (err) {
    console.error(`Request decision notification (${kind} #${id}) failed:`, err);
  }
}

const FIELD_HY = {
  name: "Անուն", category: "Տեսակ", phone: "Հեռախոս", address: "Հասցե", notes: "Նշումներ", lat: "Քարտեզի կետ", lng: "Քարտեզի կետ",
  visit_frequency_days: "Այցերի հաճախականություն", erp_customer_id: "ERP ID", tin: "ՀՎՀՀ", legal_name: "Իրավաբանական անվանում",
  legal_address: "Իրավաբանական հասցե", region: "Մարզ", subregion: "Համայնք", customer_tier: "Գնային մակարդակ", assigned_manager_id: "Մենեջեր",
  sales_channel: "Վաճառքի ալիք", credit_term_days: "Վարկի ժամկետ", payment_method: "Վճարման եղանակ",
};

// The request's own facts as push lines: the customer (name + ERP id), the amount, and what the kind needs said.
export function requestLines(request) {
  const d = request.details ?? {};
  const kindLines = {
    discount: [
      d.order_code ? `Պատվեր՝ ${d.order_code}` : null,
      d.discount_amd > 0 ? `Զեղչ՝ ${d.discount_pct}% (${amdText(d.discount_amd)})` : null,
      d.below_landing ? "Գինը ներմուծման ինքնարժեքից ցածր է" : d.below_cost ? "Գինը զուտ ինքնարժեքից ցածր է" : null,
    ],
    return: [d.order_code ? `Պատվեր՝ ${d.order_code}` : null],
    customer_edit: [`Փոփոխվում է՝ ${[...new Set((d.changes ?? []).map((c) => FIELD_HY[c.field] ?? c.field))].join(", ")}`],
    cashflow: [d.action === "delete" ? "Ջնջել գրառումը" : "Փոխել գրառումը", d.entry?.entry_date ? `Ամսաթիվ՝ ${d.entry.entry_date}` : null],
    visit_plan: [d.plan_date ? `Օր՝ ${d.plan_date}` : null, `${(d.stops ?? []).length} կանգառ`],
    perf_plan: [d.month ? `Ամիս՝ ${d.month}` : null],
    bonus_claim: [d.challenge ? `Մրցույթ՝ ${d.challenge}` : null],
  }[request.kind] ?? [];
  return [
    request.customer ? `Հաճախորդ՝ ${request.customer.name}${request.customer.erp_id ? ` · ID ${request.customer.erp_id}` : ""}` : null,
    request.amount_amd !== null && request.amount_amd !== undefined ? `Գումար՝ ${amdText(request.amount_amd)}` : null,
    ...kindLines,
  ];
}

// notifyApprovers for a request that is already saved (committed): reads it once for its facts, requester and lines.
export async function notifyApproversOf(kind, id, { type = "approval_request", titleKind = kind, extra = [] } = {}) {
  try {
    const request = await loadRequest(pool, kind, Number(id));
    if (!request || request.status !== "pending") return [];
    const titled = kind === "return" && request.details?.return_kind === "cancel" ? "cancel" : titleKind;
    return notifyApprovers({ kind, id: request.id, type, titleKind: titled, lines: [...requestLines(request), ...extra], requesterId: request.requested_by_id, facts: request.facts });
  } catch (err) {
    console.error(`Request notification (${kind} #${id}) failed:`, err);
    return [];
  }
}

// notifyDecision for a request whose decision is saved: reads it for the requester and the lines.
export async function notifyDecisionOf(kind, id, { deciderId, approved, reason = null, type = "approval_result" }) {
  try {
    const request = await loadRequest(pool, kind, Number(id));
    if (!request) return;
    const titleKind = kind === "return" && request.details?.return_kind === "cancel" ? "cancel" : kind;
    await notifyDecision({ kind, id: request.id, deciderId, requesterId: request.requested_by_id, approved, reason, type, titleKind, lines: requestLines(request) });
  } catch (err) {
    console.error(`Request decision notification (${kind} #${id}) failed:`, err);
  }
}
