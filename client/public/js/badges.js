// The navigation and Home-tile badges (pending orders, payments, warehouse, delivery, accounting, the bell, Settings): their counts,
// the last known counts kept on the device for the first paint, and the refresh calls. Moved out of app.js so a screen that repaints
// a badge (Home, Money) does not import the app shell (docs/architecture-roadmap.md, step 2).
import { api } from "./api.js";
import { state, isAdmin, canPlanForOthers } from "./state.js";
import { seesUnrecordedBadge } from "./shared/roles.js";

// Every badge count below starts back at 0 on every single page load --
// nothing persists them, unlike the cached-user optimistic render right
// above (see state.js's loadCachedUser/setUser). That's invisible on its
// own, but combined with the cold-boot optimistic render (and, on the
// dashboard specifically, its own stale-then-live re-paint), it means the
// Home tab's quick-action badges (Payments/Warehouse/Delivery/Recorded)
// reliably render hidden on the first paint or two and then pop in once
// each badge's own network call resolves -- reported as "home tab opens
// without badge numbers and reopens again with them, like refreshing".
// Persisting the last known counts (mirroring loadCachedUser's own
// localStorage round trip) lets the very first paint already show
// whatever was last known instead of a guaranteed-wrong "nothing pending"
// -- refreshAllBadges below still corrects it quietly the moment the real
// counts land, exactly as it already did.
const BADGE_CACHE_KEY = "fieldvisits_cached_badge_counts";

function loadCachedBadgeCounts() {
  try {
    const raw = localStorage.getItem(BADGE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persistBadgeCounts() {
  try {
    localStorage.setItem(
      BADGE_CACHE_KEY,
      JSON.stringify({
        orders: orderBadgeCount,
        payments: paymentBadgeCount,
        unrecorded: unrecordedBadgeCount,
        warehouse: warehouseBadgeCount,
        accounting: accountingBadgeCount,
        delivery: deliveryBadgeCount,
        notifications: unreadNotificationCount,
        planApprovals: planApprovalBadgeCount,
        editRequests: editRequestBadgeCount,
      })
    );
  } catch {
    // Best-effort; losing this just means the next cold boot starts at 0
    // again, same as before this cache existed.
  }
}

// How many orders are sitting in "submitted" waiting on a director's
// confirm/reject/edit -- shown as a badge on the Orders nav icon. The
// server returns 0 for anyone who isn't a director/admin, so this is safe
// to poll unconditionally rather than gating it on the logged-in role here
// too. orders.js fires "orders-changed" on the window after a confirm/
// reject/edit so the badge updates immediately instead of waiting for the
// next poll.
let orderBadgeCount = 0;

export function applyOrderBadge() {
  // Two possible badge elements: the bottom-nav Orders tab (mobile) and
  // the sidebar's Orders item (desktop) -- only one is ever actually in
  // the DOM at a time (see the "Desktop shell" CSS section), but both ids
  // are queried unconditionally rather than branching on viewport width.
  const els = [document.getElementById("orders-nav-badge"), document.getElementById("sidebar-orders-badge")].filter(Boolean);
  for (const el of els) {
    if (orderBadgeCount > 0) {
      el.textContent = orderBadgeCount > 99 ? "99+" : String(orderBadgeCount);
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
}

export async function refreshOrderBadge() {
  if (!state.user) return;
  try {
    const { count } = await api.getOrdersPendingCount();
    orderBadgeCount = count;
  } catch {
    // Transient network/auth failure -- leave the last known count showing
    // rather than flashing the badge away.
    return;
  }
  applyOrderBadge();
  persistBadgeCounts();
}

window.addEventListener("orders-changed", refreshOrderBadge);
// A screen that just refreshed its own list (Orders) asks for the nav counts to be refreshed with it.
window.addEventListener("badges-refresh", () => refreshAllBadgesFromServer());

// Same pattern as the Orders badge above, on the Payments quick action --
// pending count is role-aware server-side (Accountant/CEO/admin get every
// payment awaiting review, a Sales Manager only their own), so this is
// safe to poll unconditionally too. payments.js fires "payments-changed"
// after a submit/approve/reject/return-to-pending so the badge updates
// immediately instead of waiting for the next poll.
let paymentBadgeCount = 0;

export function applyPaymentBadge() {
  const el = document.getElementById("qa-payments-badge");
  if (!el) return;
  if (paymentBadgeCount > 0) {
    el.textContent = paymentBadgeCount > 99 ? "99+" : String(paymentBadgeCount);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

export async function refreshPaymentBadge() {
  if (!state.user) return;
  try {
    const { count } = await api.getPaymentsPendingCount();
    paymentBadgeCount = count;
  } catch {
    return;
  }
  applyPaymentBadge();
  persistBadgeCounts();
}

window.addEventListener("payments-changed", refreshPaymentBadge);

// Same pattern again, on the accountant "Recorded" quick action -- the
// unrecorded-delivered-order backlog (accountant/CEO/admin only server-side,
// see roles.js's seesUnrecordedBadge). recorded.js fires
// "recorded-changed" after a checkbox toggle so this updates immediately.
let unrecordedBadgeCount = 0;

export function applyUnrecordedBadge() {
  const el = document.getElementById("unrecorded-badge");
  if (!el) return;
  if (unrecordedBadgeCount > 0) {
    el.textContent = unrecordedBadgeCount > 99 ? "99+" : String(unrecordedBadgeCount);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

export async function refreshUnrecordedBadge() {
  if (!state.user || !seesUnrecordedBadge(state.user.role)) return;
  try {
    const { count } = await api.getUnrecordedCount();
    unrecordedBadgeCount = count;
  } catch {
    return;
  }
  applyUnrecordedBadge();
  persistBadgeCounts();
}

window.addEventListener("recorded-changed", refreshUnrecordedBadge);

// Same pattern again, on the Warehouse quick action -- how many orders are
// sitting confirmed, awaiting packing (role-aware server-side, see
// warehouse.js's own pending-count). warehouse.js fires "warehouse-changed"
// after a pack/bulk-pack/flag-stock-issue action, and orders.js fires it
// when an order is confirmed (the moment it enters this queue), so the
// badge doesn't lag a full poll cycle behind either direction.
let warehouseBadgeCount = 0;

export function applyWarehouseBadge() {
  // the Home tile's badge and the warehouse shell's Pack tab(s)
  for (const el of [document.getElementById("qa-warehouse-badge"), ...document.querySelectorAll('[data-shell-badge="warehouse"]')]) {
    if (!el) continue;
    if (warehouseBadgeCount > 0) {
      el.textContent = warehouseBadgeCount > 99 ? "99+" : String(warehouseBadgeCount);
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
}

export async function refreshWarehouseBadge() {
  if (!state.user) return;
  try {
    const { count } = await api.getWarehousePendingCount();
    warehouseBadgeCount = count;
  } catch {
    return;
  }
  applyWarehouseBadge();
  persistBadgeCounts();
}

window.addEventListener("warehouse-changed", refreshWarehouseBadge);

// Same pattern again, on the Accounting quick action -- requests Lily has not
// finished (accounting roles) or orders whose document is ready (warehouse);
// 0 for everyone else (see server/src/orders/accountingBadge.js). The Accounting
// page fires "accounting-changed" after each load so the number follows.
let accountingBadgeCount = 0;

export function applyAccountingBadge() {
  const el = document.getElementById("qa-accounting-badge");
  if (!el) return;
  if (accountingBadgeCount > 0) {
    el.textContent = accountingBadgeCount > 99 ? "99+" : String(accountingBadgeCount);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

export async function refreshAccountingBadge() {
  if (!state.user) return;
  try {
    const { count } = await api.getAccountingCount();
    accountingBadgeCount = count;
  } catch {
    return;
  }
  applyAccountingBadge();
  persistBadgeCounts();
}

window.addEventListener("accounting-changed", refreshAccountingBadge);

// Same pattern again, on the Delivery quick action -- packed orders still
// awaiting a route plus route stops not yet delivered (role-aware
// server-side, see delivery.js's own pending-count). deliveryRoute.js
// fires "delivery-changed" after planning a route or confirming/failing a
// delivery, and orders.js fires it on the manual mark-delivered-without-
// route override too.
let deliveryBadgeCount = 0;

export function applyDeliveryBadge() {
  for (const el of [document.getElementById("qa-delivery-badge"), ...document.querySelectorAll('[data-shell-badge="delivery"]')]) {
    if (!el) continue;
    if (deliveryBadgeCount > 0) {
      el.textContent = deliveryBadgeCount > 99 ? "99+" : String(deliveryBadgeCount);
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
}

export async function refreshDeliveryBadge() {
  if (!state.user) return;
  try {
    const { count } = await api.getDeliveryPendingCount();
    deliveryBadgeCount = count;
  } catch {
    return;
  }
  applyDeliveryBadge();
  persistBadgeCounts();
}

window.addEventListener("delivery-changed", refreshDeliveryBadge);

// Same pattern as the Orders badge above -- polled and also refreshed
// on-demand (here, whenever the Notifications page marks something read)
// so the bell badge doesn't lag behind what the user just saw.
let unreadNotificationCount = 0;

export function applyNotificationBadge() {
  const el = document.getElementById("topbar-bell-badge");
  if (!el) return;
  if (unreadNotificationCount > 0) {
    el.textContent = unreadNotificationCount > 99 ? "99+" : String(unreadNotificationCount);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

export async function refreshNotificationBadge() {
  if (!state.user) return;
  try {
    const { count } = await api.getUnreadNotificationCount();
    unreadNotificationCount = count;
  } catch {
    return;
  }
  applyNotificationBadge();
  persistBadgeCounts();
}

// Same pattern again, on the hamburger/settings button -- a plan stuck in
// "Plan approvals" (Settings > Admin workspace) silently blocks that rep's
// Map "Planned" filter with no other visible sign anything needs review,
// so surface the count right where the button is. canPlanForOthers-gated
// client-side too, not just server-side: GET /visit-plans/pending 403s for
// anyone else, and there's no reason to fire that request for roles that
// can never see this queue. admin.js's plan-approvals section fires
// "plans-changed" after an approve/reject so this updates immediately.
//
// editRequestBadgeCount shares this same badge (they both mean "something
// in Settings > Admin workspace needs your review") rather than getting a
// second badge of its own -- previously the only way to notice a pending
// customer edit request was to happen to reopen that exact customer's own
// card, reported live as "I don't get a notification about those
// requests". admin.js's edit-requests section fires "edit-requests-changed"
// the same way plan approvals fires "plans-changed".
let planApprovalBadgeCount = 0;
let editRequestBadgeCount = 0;

export function applyPlanApprovalBadge() {
  const el = document.getElementById("topbar-menu-badge");
  if (!el) return;
  const total = planApprovalBadgeCount + editRequestBadgeCount;
  if (total > 0) {
    el.textContent = total > 99 ? "99+" : String(total);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

export async function refreshPlanApprovalBadge() {
  if (!state.user || !canPlanForOthers()) return;
  try {
    const plans = await api.getPendingVisitPlans();
    planApprovalBadgeCount = plans.length;
  } catch {
    return;
  }
  applyPlanApprovalBadge();
  persistBadgeCounts();
}

export async function refreshEditRequestBadge() {
  if (!state.user || !isAdmin()) return;
  try {
    const requests = await api.listEditRequests({ status: "pending" });
    editRequestBadgeCount = requests.length;
  } catch {
    return;
  }
  applyPlanApprovalBadge();
  persistBadgeCounts();
}

window.addEventListener("plans-changed", refreshPlanApprovalBadge);
window.addEventListener("edit-requests-changed", refreshEditRequestBadge);

// The last known counts, painted before the first network answer (see BADGE_CACHE_KEY above).
export function restoreCachedBadgeCounts() {
  const cachedBadgeCounts = loadCachedBadgeCounts();
  if (!cachedBadgeCounts) return;
  orderBadgeCount = cachedBadgeCounts.orders ?? 0;
  paymentBadgeCount = cachedBadgeCounts.payments ?? 0;
  unrecordedBadgeCount = cachedBadgeCounts.unrecorded ?? 0;
  warehouseBadgeCount = cachedBadgeCounts.warehouse ?? 0;
  accountingBadgeCount = cachedBadgeCounts.accounting ?? 0;
  deliveryBadgeCount = cachedBadgeCounts.delivery ?? 0;
  unreadNotificationCount = cachedBadgeCounts.notifications ?? 0;
  planApprovalBadgeCount = cachedBadgeCounts.planApprovals ?? 0;
  editRequestBadgeCount = cachedBadgeCounts.editRequests ?? 0;
}

// Not more often than every few seconds, however many triggers (focus, visibility, pageshow, online, a screen refresh)
// fire together.
let lastBadgeFetchAt = 0;
export async function refreshAllBadgesFromServer() {
  if (!state.user) return;
  if (Date.now() - lastBadgeFetchAt < 4000) return;
  lastBadgeFetchAt = Date.now();
  let counts;
  try {
    counts = await api.getBadgeCounts();
  } catch {
    return;
  }
  orderBadgeCount = counts.orders;
  paymentBadgeCount = counts.payments;
  unrecordedBadgeCount = counts.unrecorded;
  warehouseBadgeCount = counts.warehouse;
  accountingBadgeCount = counts.accounting ?? 0;
  deliveryBadgeCount = counts.delivery;
  unreadNotificationCount = counts.notifications;
  planApprovalBadgeCount = counts.planApprovals;
  editRequestBadgeCount = counts.editRequests;
  applyOrderBadge();
  applyPaymentBadge();
  applyUnrecordedBadge();
  applyWarehouseBadge();
  applyAccountingBadge();
  applyDeliveryBadge();
  applyNotificationBadge();
  applyPlanApprovalBadge();
  persistBadgeCounts();
}
