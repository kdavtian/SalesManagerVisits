import { api } from "./api.js";
import { state, setUser, isAdmin, canPlanForOthers, loadCachedUser } from "./state.js";
import { getLang, t } from "./i18n.js";
import { icons } from "./icons.js";
// Every view module below is loaded on demand (dynamic import()) from
// render()'s route dispatch instead of statically here -- on boot, only the
// screen the user actually lands on needs to be fetched/parsed/evaluated,
// not all ~24 of them. The browser's module cache means each is still only
// fetched once per session (revisiting a route is instant, same as a static
// import would have been); this only changes when the fetch happens, not
// how often. This mirrors the dynamic-import pattern already used elsewhere
// in this codebase for cross-view references (e.g. customerOrders.js's own
// import("./customerDetail.js")).
import { flushQueue, getQueue, onQueueChange } from "./offlineQueue.js";
import { clearListCache, clearCacheIfRoleChanged } from "./listCache.js";
import { mountInstallPrompt } from "./install.js";
import { mountUpdateBanner, initServiceWorkerUpdates } from "./updateBanner.js";
import { startLocationBroadcast, stopLocationBroadcast } from "./locationBroadcast.js";
import { escapeHtml } from "./util.js";
import { QUICK_ACTIONS, QUICK_ACTION_ROUTE, visibleQuickActionIds } from "./quickActions.js";
import { startErrorMonitoring } from "./errorMonitoring.js";

const app = document.getElementById("app");
const navBar = document.getElementById("nav-bar");
const topBar = document.getElementById("top-bar");
const sidebar = document.getElementById("sidebar");
// The true baseline for #app/document.body's class lists, captured before
// any view has ever mounted -- some views (map.js) add classes here as a
// mount-time side effect (locking #app's own scroll, an opaque nav-bar
// background) and remove them again in their cleanup function. The
// back-cache below defers that cleanup for a stashed-but-not-yet-evicted
// view, so it can no longer be trusted to run before the next route
// mounts; render() resets to this baseline itself instead (see the
// back-cache stash/restore logic).
const baseAppClassName = app.className;
const baseBodyClassName = document.body.className;

// #app (not the document) is the app's real scroll container -- body stays
// overflow:hidden so the fixed top/nav bars never drift with content (see
// styles.css). That means iOS's native "tap the status bar to scroll to
// top" gesture has nothing to reach: it only ever targets the document's
// own scroll view, and there's no way to intercept a tap on the real status
// bar from a web page at all. Tapping the top bar itself -- the strip
// immediately below the real status bar -- is the standard PWA stand-in for
// that gesture, so wire it here once for every page rather than per view.
topBar.addEventListener("click", (e) => {
  if (e.target.closest("button, a")) return;
  app.scrollTo({ top: 0, behavior: "smooth" });
});
const syncBanner = document.getElementById("sync-banner");
const installRoot = document.getElementById("install-root");
const updateRoot = document.getElementById("update-root");
mountUpdateBanner(updateRoot);
// Dynamic views and sheets share the same feedback classes. Assign live
// semantics as they appear so async errors/success messages are announced.
// The scan itself (querySelectorAll per added node) does real work -- on a
// big list re-render (search results, a filtered order/customer list) the
// observer's addedNodes can be hundreds of cards, and none of them ever
// carry .form-error/.form-success (per this app's own convention, an error
// swapped into a list container is the container's only child, not mixed in
// alongside its rows) -- but the observer has no way to know that up front,
// so it still has to check. Deferred to idle time (a Safari-safe fallback
// stands in for requestIdleCallback, which WebKit has never implemented) so
// this bookkeeping never competes with the same-frame work of the render
// that triggered it -- the assistive-tech announcement lands a beat later,
// not the visible UI.
const runWhenIdle =
  window.requestIdleCallback || ((cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1));
let pendingFeedbackNodes = [];
let feedbackScanScheduled = false;
function scanPendingFeedbackNodes() {
  feedbackScanScheduled = false;
  const nodes = pendingFeedbackNodes;
  pendingFeedbackNodes = [];
  for (const node of nodes) {
    if (!node.isConnected) continue;
    // Only elements that actually carry one of these two classes get a
    // live-region role -- `node` itself is only a candidate, not
    // automatically a match; without this filter every freshly-rendered
    // top-level element (nav rows, tappable cards, anything with its own
    // role="...") had its role silently overwritten to "status" the
    // moment it was inserted.
    const feedback = [node, ...node.querySelectorAll(".form-error, .form-success")].filter(
      (el) => el.classList.contains("form-error") || el.classList.contains("form-success")
    );
    feedback.forEach((el) => el.setAttribute("role", el.classList.contains("form-error") ? "alert" : "status"));
  }
}
new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node instanceof HTMLElement) pendingFeedbackNodes.push(node);
    }
  }
  if (!feedbackScanScheduled && pendingFeedbackNodes.length) {
    feedbackScanScheduled = true;
    runWhenIdle(scanPendingFeedbackNodes);
  }
}).observe(document.body, { childList: true, subtree: true });

// Bottom-nav tabs + Settings are the routes a rep hits over and over in a
// working day. render()'s dynamic import() above means the very first tap
// on each still costs a fetch -- fine on a normal SPA session where the
// module cache then makes every later tap instant, but iOS Safari discards
// a backgrounded PWA's whole page (module cache included) far more
// aggressively than Android. Without this, switching apps or unlocking the
// phone and coming back means the next tab tap is a fresh "first visit"
// again, which is exactly the "loading every time" symptom reported live
// from an iPhone. Warming these during idle time right after boot/login
// means that fetch has almost always already happened by the time a tap
// comes in, without touching the boot-time win the dynamic import()s were
// for -- this doesn't block first paint, it just gets ahead of the taps
// that follow it.
let coreViewsPreloaded = false;
function preloadCoreViews() {
  if (coreViewsPreloaded) return;
  coreViewsPreloaded = true;
  runWhenIdle(() => {
    [
      "./views/dashboard.js",
      "./views/activity.js",
      "./views/map.js",
      "./views/customers.js",
      "./views/orders.js",
      "./views/settings.js",
    ].forEach((path) => import(path).catch(() => {}));
    // Leaflet itself (leafletLoader.js) is loaded on demand rather than
    // unconditionally at page load now -- warmed here alongside map.js's
    // own module fetch so the two are usually both ready together by the
    // time a tap actually opens Map or Add-customer.
    import("./leafletLoader.js").then((m) => m.ensureLeaflet()).catch(() => {});
  });
}

// Same "loads too slow" complaint, for the map's basemap tiles specifically
// -- OSM tile requests from a device in Armenia can genuinely take several
// seconds each (see the tile-health-check comment in map.js), so by the
// time a rep opens the Map tab it's too late to start fetching. Warms the
// whole-country view (zoom 6-9: country-to-city, not the zoom-15
// per-customer grid, which would be tens of thousands of tiles over an area
// that isn't even known yet) into the service worker's tile cache during
// idle time, so those tiles are usually already local by the time Map is
// opened. sw.js's fetch handler already caches any tile.openstreetmap.org
// request regardless of who made it, so a plain fetch() here is enough --
// no message-passing to the service worker needed.
const ARMENIA_TILE_BOUNDS = { west: 43.4, east: 46.7, south: 38.8, north: 41.35 };
const ARMENIA_TILE_ZOOMS = [6, 7, 8, 9];
const TILE_SUBDOMAINS = "abc";

function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}
function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}

let tilesPreloadScheduled = false;
const TILE_PREWARM_STORAGE_KEY = "fieldvisits_tiles_prewarmed_at";
const TILE_PREWARM_INTERVAL_MS = 24 * 60 * 60 * 1000;

function preloadArmeniaTiles() {
  if (tilesPreloadScheduled) return;
  tilesPreloadScheduled = true;
  // Data Saver is an explicit "don't spend my data in the background"
  // signal -- unsupported on iOS Safari (this feature's main audience),
  // where it's simply undefined and this check is a no-op.
  if (navigator.connection?.saveData) return;
  let lastRun = 0;
  try {
    lastRun = Number(localStorage.getItem(TILE_PREWARM_STORAGE_KEY)) || 0;
  } catch {
    // Storage can throw in a locked-down/private-browsing context -- treat
    // that the same as "never warmed" rather than skipping the feature.
  }
  if (Date.now() - lastRun < TILE_PREWARM_INTERVAL_MS) return;
  runWhenIdle(async () => {
    const tiles = [];
    for (const z of ARMENIA_TILE_ZOOMS) {
      const xMin = lonToTileX(ARMENIA_TILE_BOUNDS.west, z);
      const xMax = lonToTileX(ARMENIA_TILE_BOUNDS.east, z);
      const yMin = latToTileY(ARMENIA_TILE_BOUNDS.north, z);
      const yMax = latToTileY(ARMENIA_TILE_BOUNDS.south, z);
      for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) tiles.push({ x, y, z });
      }
    }
    // A handful of parallel fetches at a time -- this is a best-effort
    // background nicety running on the user's own data/battery while the
    // app is idle, not a race to finish, so it shouldn't compete with
    // whatever the user is actually doing on the network right when the
    // app opens.
    let next = 0;
    async function worker() {
      while (next < tiles.length) {
        const { x, y, z } = tiles[next++];
        const s = TILE_SUBDOMAINS[(x + y) % TILE_SUBDOMAINS.length];
        const url = `https://${s}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
        try {
          await fetch(url);
        } catch {
          // Offline or unreachable -- fine, this is best-effort warmup; the
          // real tile fetch/retry/fallback-provider logic in map.js still
          // runs normally whenever Map is actually opened.
        }
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));
    try {
      localStorage.setItem(TILE_PREWARM_STORAGE_KEY, String(Date.now()));
    } catch {
      // Non-fatal if storage isn't writable.
    }
  });
}

let currentCleanup = null;
let currentPath = null;
let fieldErrorId = 0;

// Single-slot "back cache": the exact DOM nodes (not a re-render) of the
// one screen most recently navigated away from, plus its scroll position
// and cleanup function -- so returning to it (the browser/PWA's own back
// button, an edge-swipe-back gesture, this app's own navigate.goBack, or
// even just landing back on that exact hash some other way) restores
// everything exactly as it was: scroll position, filter/sort selections,
// search text, an expanded accordion, all of it, since it's literally the
// same nodes with their listeners intact, not new markup with fresh JS
// state. Deliberately only one slot, not a full per-route history: every
// navigation (forward or back) evicts whatever didn't match and stashes
// the screen being left instead, so the cache only ever holds the single
// most recent hop -- which is exactly what makes "tap Orders from a
// customer's detail page, then tap Customers again" correctly get a FRESH
// list rather than the one left two hops ago: by the time that tap
// happens, the cache slot has already been overwritten by the detail
// page's own stash and no longer holds the old Customers state at all.
let backCache = null; // { hash, nodes: DocumentFragment, cleanup, scrollTop }
let lastRenderedHash = null;
// Remembers the hash we were on right before navigating into Settings, so
// tapping the top-bar menu button a second time can act as a "close" and
// return there, instead of just re-navigating to #/settings every time.
let preSettingsHash = "#/dashboard";

// Every screen reachable from the Home tab's own quick-action grid --
// tapping the bottom-nav Home icon while on one of these (or Dashboard
// itself) means "I'm already in the Home tab, take me to its actual
// start", but tapping it from anywhere else (Customers, Map, Activity,
// Orders, Settings, a detail page) should return to whichever of these
// was open last, not always reset to Dashboard (reported as "opens home
// tab from 0"). #/map is deliberately excluded even though two quick
// actions route there -- it's already its own separate bottom-nav tab,
// not part of the Home tree.
const HOME_TREE_ROUTES = new Set(["#/dashboard", ...Object.values(QUICK_ACTION_ROUTE).map((h) => h.split("?")[0])]);
HOME_TREE_ROUTES.delete("#/map");
let lastHomeHash = "#/dashboard";

// The bottom-nav bar's own 5 tab roots (see renderNav's NAV_ITEMS) -- a tap
// on one of these is always a lateral "switch tab" action, never a "drill
// deeper" one, so navigate() below replaces the current history entry
// instead of pushing a new one for these specifically. Without this, every
// tab switch grew the single shared browser history stack right alongside
// genuine drill-downs (a customer detail page, a sheet's own hash, ...), so
// the PWA/browser's edge-swipe-back gesture -- which just calls
// history.back() once -- would as often land on whatever OTHER tab was open
// before the switch as it would step back within the tab the user is
// actually on (reported as "swipe back switches tabs instead of going to
// the previous page on the same tab").
const NAV_TAB_ROOT_HASHES = new Set(["#/dashboard", "#/activity", "#/map", "#/customers", "#/orders"]);

function homeNavTarget() {
  const currentPath = (location.hash || "#/dashboard").split("?")[0];
  return HOME_TREE_ROUTES.has(currentPath) ? "#/dashboard" : lastHomeHash;
}

// How many orders are sitting in "submitted" waiting on a director's
// confirm/reject/edit -- shown as a badge on the Orders nav icon. The
// server returns 0 for anyone who isn't a director/admin, so this is safe
// to poll unconditionally rather than gating it on the logged-in role here
// too. orders.js fires "orders-changed" on the window after a confirm/
// reject/edit so the badge updates immediately instead of waiting for the
// next poll.
let orderBadgeCount = 0;

function applyOrderBadge() {
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

async function refreshOrderBadge() {
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
}

window.addEventListener("orders-changed", refreshOrderBadge);

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

async function refreshPaymentBadge() {
  if (!state.user) return;
  try {
    const { count } = await api.getPaymentsPendingCount();
    paymentBadgeCount = count;
  } catch {
    return;
  }
  applyPaymentBadge();
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

async function refreshUnrecordedBadge() {
  if (!state.user || !["accountant", "ceo", "operations_director", "admin"].includes(state.user.role)) return;
  try {
    const { count } = await api.getUnrecordedCount();
    unrecordedBadgeCount = count;
  } catch {
    return;
  }
  applyUnrecordedBadge();
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
  const el = document.getElementById("qa-warehouse-badge");
  if (!el) return;
  if (warehouseBadgeCount > 0) {
    el.textContent = warehouseBadgeCount > 99 ? "99+" : String(warehouseBadgeCount);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function refreshWarehouseBadge() {
  if (!state.user) return;
  try {
    const { count } = await api.getWarehousePendingCount();
    warehouseBadgeCount = count;
  } catch {
    return;
  }
  applyWarehouseBadge();
}

window.addEventListener("warehouse-changed", refreshWarehouseBadge);

// Same pattern again, on the Delivery quick action -- packed orders still
// awaiting a route plus route stops not yet delivered (role-aware
// server-side, see delivery.js's own pending-count). deliveryRoute.js
// fires "delivery-changed" after planning a route or confirming/failing a
// delivery, and orders.js fires it on the manual mark-delivered-without-
// route override too.
let deliveryBadgeCount = 0;

export function applyDeliveryBadge() {
  const el = document.getElementById("qa-delivery-badge");
  if (!el) return;
  if (deliveryBadgeCount > 0) {
    el.textContent = deliveryBadgeCount > 99 ? "99+" : String(deliveryBadgeCount);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function refreshDeliveryBadge() {
  if (!state.user) return;
  try {
    const { count } = await api.getDeliveryPendingCount();
    deliveryBadgeCount = count;
  } catch {
    return;
  }
  applyDeliveryBadge();
}

window.addEventListener("delivery-changed", refreshDeliveryBadge);

// Same pattern as the Orders badge above -- polled and also refreshed
// on-demand (here, whenever the Notifications page marks something read)
// so the bell badge doesn't lag behind what the user just saw.
let unreadNotificationCount = 0;

function applyNotificationBadge() {
  const el = document.getElementById("topbar-bell-badge");
  if (!el) return;
  if (unreadNotificationCount > 0) {
    el.textContent = unreadNotificationCount > 99 ? "99+" : String(unreadNotificationCount);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function refreshNotificationBadge() {
  if (!state.user) return;
  try {
    const { count } = await api.getUnreadNotificationCount();
    unreadNotificationCount = count;
  } catch {
    return;
  }
  applyNotificationBadge();
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

async function refreshPlanApprovalBadge() {
  if (!state.user || !canPlanForOthers()) return;
  try {
    const plans = await api.getPendingVisitPlans();
    planApprovalBadgeCount = plans.length;
  } catch {
    return;
  }
  applyPlanApprovalBadge();
}

async function refreshEditRequestBadge() {
  if (!state.user || !isAdmin()) return;
  try {
    const requests = await api.listEditRequests({ status: "pending" });
    editRequestBadgeCount = requests.length;
  } catch {
    return;
  }
  applyPlanApprovalBadge();
}

window.addEventListener("plans-changed", refreshPlanApprovalBadge);
window.addEventListener("edit-requests-changed", refreshEditRequestBadge);

// Tracks whether this SPA session has done at least one in-app navigation
// (as opposed to just rendering whatever hash the app happened to boot
// into, e.g. a deep link or a notification tap straight into a detail
// page). Lets a "back" button distinguish "there's a real previous screen
// in this tab's history I can return to" from "there isn't, so jump to a
// sensible default instead" -- see navigate.goBack below.
let hasNavigatedInApp = false;

function navigate(hash) {
  if (location.hash === hash) {
    // Already exactly on this route (tapping the same active nav icon
    // again, e.g. Customers while already at the Customers list root) --
    // a no-op. This used to force a full render(), which tears the whole
    // view down and rebuilds it (a visible reload/loading flash every
    // single tap) for a screen that hasn't gone anywhere.
    return;
  }
  hasNavigatedInApp = true;
  if (NAV_TAB_ROOT_HASHES.has(hash.split("?")[0])) {
    // See NAV_TAB_ROOT_HASHES above -- replace rather than push, so hopping
    // between bottom-nav tabs never grows the shared browser history stack.
    // replaceState doesn't fire hashchange on its own, so it's dispatched
    // manually -- render() below is one listener, but mapSafeUi.js,
    // customerSocialProfiles.js and ordersRegionStatusEnhancements.js each
    // register their own route-driven hashchange listener too, and all of
    // them need to run exactly as they would for a normal push navigation.
    history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  location.hash = hash;
}

// A detail-style page's back button should return wherever the user
// actually came from (Activity, Map, Dashboard, a filtered Customers list,
// ...), not always the same hardcoded parent route -- that only happens to
// be right if the user always arrives the same way, which they don't.
// Falls back to fallbackHash only when there's genuinely nothing in this
// session's history to go back to (e.g. the detail page was the very first
// thing this tab loaded, from a deep link or a push notification).
navigate.goBack = (fallbackHash) => {
  if (hasNavigatedInApp) {
    history.back();
  } else {
    navigate(fallbackHash);
  }
};

async function doLogout() {
  await api.logout();
  setUser(null);
  stopLocationBroadcast();
  // Defense-in-depth alongside listCache.js's own per-user key scoping --
  // a shared device's next sign-in should never be able to see this rep's
  // cached orders/customers/activity data (reported as "another user's
  // orders can appear").
  await clearListCache();
  location.hash = "";
  render();
}

async function render() {
  document.documentElement.lang = getLang();
  // Any open sheet/dialog overlay is appended straight to document.body,
  // outside the routed view container render() replaces below -- so
  // navigating away (an in-app back button, but especially the browser/
  // PWA's own edge-swipe-back gesture, which changes location.hash without
  // going through any of this app's own close handlers) used to leave it
  // floating on screen over whatever the new route rendered underneath,
  // instead of closing along with the page it belonged to.
  document.querySelectorAll(".sheet-overlay").forEach((el) => el.remove());

  if (!state.user) {
    if (currentCleanup) {
      currentCleanup();
      currentCleanup = null;
    }
    // A logged-out session's back-cache would otherwise hold onto this
    // account's DOM (and whatever cleanup it owned) across a login screen
    // that might belong to a different account entirely on a shared device.
    backCache?.cleanup?.();
    backCache = null;
    lastRenderedHash = null;
    topBar.hidden = true;
    navBar.hidden = true;
    sidebar.hidden = true;
    const { renderLogin } = await import("./views/login.js");
    renderLogin(app, async () => {
      location.hash = "#/dashboard";
      startLocationBroadcast();
      // A session that expired while this device had queued offline work
      // stops flushQueue() at the first 401 rather than deleting that work
      // (see offlineQueue.js) -- nothing else re-triggers a flush once the
      // rep is back online AND re-authenticated (the 'online' listener
      // already fired before they logged back in), so a fresh login is the
      // other point that needs its own retry.
      flushQueue();
      render();
      refreshOrderBadge();
      refreshPaymentBadge();
      refreshUnrecordedBadge();
      refreshWarehouseBadge();
      refreshDeliveryBadge();
      refreshNotificationBadge();
      refreshPlanApprovalBadge();
    });
    return;
  }

  topBar.hidden = false;
  navBar.hidden = false;
  sidebar.hidden = false;
  renderNav();
  mountInstallPrompt(installRoot);
  preloadCoreViews();
  preloadArmeniaTiles();

  const hash = location.hash || "#/dashboard";
  if (HOME_TREE_ROUTES.has(hash.split("?")[0])) lastHomeHash = hash;

  // Restore from the back-cache -- only on a genuine back/forward
  // navigation (see the popstate listener below), and only when it's the
  // exact screen we most recently left. Reattaches the same DOM nodes (so
  // every click listener, timer, and closure-held filter/sort/search state
  // is still exactly as it was) instead of asking the route's view module
  // to rebuild everything from scratch and lose all of it.
  if (backCache && backCache.hash === hash) {
    if (currentCleanup) {
      currentCleanup();
      currentCleanup = null;
    }
    const { nodes, cleanup, scrollTop, appClassName, bodyClassName } = backCache;
    backCache = null;
    app.replaceChildren(nodes);
    // Reapply whatever #app/document.body class customization the
    // restored view had made at mount time (e.g. map.js's scroll lock) --
    // stripped below when it was stashed, since its own cleanup function
    // (the only thing that normally removes them) is deferred, not run,
    // while a view sits in the back-cache.
    app.className = appClassName ?? baseAppClassName;
    document.body.className = bodyClassName ?? baseBodyClassName;
    currentCleanup = cleanup || null;
    lastRenderedHash = hash;
    requestAnimationFrame(() => {
      app.scrollTop = scrollTop;
    });
    return;
  }

  // Not restoring: whatever is currently mounted is about to be replaced.
  // Stash it into the single back-cache slot first (so a subsequent "back"
  // to exactly this hash is instant) unless there's nothing to stash (first
  // paint) or we're already on this exact hash (a re-render of the same
  // route, e.g. after a settings change). A stale, unconsumed cache entry
  // from an earlier hop is disposed here rather than silently dropped, so
  // whatever cleanup it owned (a timer, a geolocation watch) still runs.
  if (backCache && backCache.hash !== hash) {
    backCache.cleanup?.();
    backCache = null;
  }
  if (lastRenderedHash && lastRenderedHash !== hash && app.firstChild) {
    // Captured BEFORE emptying #app below -- a scroll container with no
    // children always reports scrollTop 0, so reading it after the move
    // loop would silently throw away the real position every time.
    const scrollTopSnapshot = app.scrollTop;
    const appClassNameSnapshot = app.className;
    const bodyClassNameSnapshot = document.body.className;
    const fragment = document.createDocumentFragment();
    while (app.firstChild) fragment.appendChild(app.firstChild);
    backCache = {
      hash: lastRenderedHash,
      nodes: fragment,
      cleanup: currentCleanup,
      scrollTop: scrollTopSnapshot,
      appClassName: appClassNameSnapshot,
      bodyClassName: bodyClassNameSnapshot,
    };
    currentCleanup = null; // ownership transferred to backCache
    // The outgoing view's cleanup function -- the only thing that would
    // normally strip any #app/document.body classes it added at mount
    // time -- isn't going to run until this cache entry is evicted, which
    // may be much later or never. The next view must not inherit them
    // (e.g. mounting a checkin page under map.js's scroll-locking class),
    // so reset to the true baseline now; restoring this entry later
    // (above) reapplies its own snapshot.
    app.className = baseAppClassName;
    document.body.className = baseBodyClassName;
  } else if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }
  lastRenderedHash = hash;

  const [path, queryString] = hash.split("?");
  if (path !== currentPath) {
    currentPath = path;
    requestAnimationFrame(() => app.focus({ preventScroll: true }));
  }
  const query = new URLSearchParams(queryString || "");
  const customerMatch = path.match(/^#\/customers\/(\d+)$/);
  const customerOrdersMatch = path.match(/^#\/customers\/(\d+)\/orders$/);
  const checkinMatch = path.match(/^#\/checkin\/(\d+)$/);
  const orderCreateMatch = path.match(/^#\/orders\/new\/(\d+)$/);
  const paymentDetailMatch = path.match(/^#\/payments\/(\d+)$/);
  const handoffDetailMatch = path.match(/^#\/cash-handoffs\/(\d+)$/);

  if (path === "#/dashboard") {
    (await import("./views/dashboard.js")).renderDashboard(app, navigate);
  } else if (path === "#/activity") {
    (await import("./views/activity.js")).renderActivity(app, navigate);
  } else if (path === "#/map") {
    const { renderMap } = await import("./views/map.js");
    currentCleanup = renderMap(
      app,
      navigate,
      query.get("relocate"),
      query.get("add") === "1",
      query.get("plan") === "1",
      query.get("customer")
    );
  } else if (path === "#/customers") {
    (await import("./views/customers.js")).renderCustomers(app, navigate, query.get("visited"));
  } else if (customerOrdersMatch) {
    (await import("./views/customerOrders.js")).renderCustomerOrders(app, navigate, customerOrdersMatch[1]);
  } else if (orderCreateMatch) {
    (await import("./views/orderCreate.js")).renderOrderCreate(app, navigate, orderCreateMatch[1], query.get("checkin"));
  } else if (path === "#/orders") {
    (await import("./views/orders.js")).renderOrders(app, navigate);
  } else if (paymentDetailMatch) {
    (await import("./views/payments.js")).renderPayments(app, navigate, paymentDetailMatch[1]);
  } else if (path === "#/payments") {
    (await import("./views/payments.js")).renderPayments(app, navigate, null, query);
  } else if (handoffDetailMatch) {
    (await import("./views/cashHandoffs.js")).renderCashHandoffs(app, navigate, handoffDetailMatch[1]);
  } else if (path === "#/cash-handoffs") {
    (await import("./views/cashHandoffs.js")).renderCashHandoffs(app, navigate);
  } else if (path === "#/expenses") {
    (await import("./views/cashExpenses.js")).renderCashExpenses(app, navigate);
  } else if (path === "#/reports") {
    (await import("./views/reports.js")).renderReports(app, navigate, query.get("r"));
  } else if (path === "#/route-plans") {
    (await import("./views/routePlans.js")).renderRoutePlans(app, navigate);
  } else if (path === "#/team-performance") {
    (await import("./views/teamPerformance.js")).renderTeamPerformance(app, navigate, query);
  } else if (path === "#/company-dashboard") {
    (await import("./views/dashboardOverview.js")).renderDashboardOverview(app, navigate);
  } else if (path === "#/pricelist") {
    (await import("./views/pricelist.js")).renderPricelist(app, navigate);
  } else if (path === "#/warehouse") {
    (await import("./views/warehouse.js")).renderWarehouse(app, navigate);
  } else if (path === "#/delivery") {
    (await import("./views/deliveryRoute.js")).renderDelivery(app, navigate);
  } else if (path === "#/recorded") {
    (await import("./views/recorded.js")).renderRecorded(app, navigate);
  } else if (path === "#/debt-balances") {
    (await import("./views/debtBalances.js")).renderDebtBalances(app, navigate);
  } else if (path === "#/sales") {
    (await import("./views/sales.js")).renderSales(app, navigate);
  } else if (customerMatch) {
    (await import("./views/customerDetail.js")).renderCustomerDetail(app, navigate, customerMatch[1]);
  } else if (checkinMatch) {
    (await import("./views/checkin.js")).renderCheckin(app, navigate, checkinMatch[1]);
  } else if (path === "#/settings") {
    (await import("./views/settings.js")).renderSettings(app, doLogout, render);
  } else if (path === "#/notifications") {
    (await import("./views/notifications.js")).renderNotifications(app, navigate, refreshNotificationBadge);
  } else if (path === "#/bonuses") {
    (await import("./views/bonuses.js")).renderBonuses(app, navigate);
  } else {
    navigate("#/dashboard");
  }
}

// Tracks the inputs renderNav()'s markup actually depends on (active tab,
// language, display name) so a navigation that doesn't change any of them
// -- the common case, e.g. Customers -> a customer's detail page -> back --
// can skip tearing down and rebuilding both bars' innerHTML (every nav
// button, the logo <img>, the bell/menu buttons, and every click listener
// on them) and just leave the existing DOM alone. Badge counts are
// unaffected by this -- applyOrderBadge/applyNotificationBadge/
// applyPlanApprovalBadge below only toggle hidden/textContent on already-
// existing elements, so they still run every call regardless.
let lastNavSignature = null;
// Home screen quick-action visibility (per-role, admin-configurable --
// see quickActions.js) is what decides the desktop sidebar's item set
// beyond the 5 core routes. Fetched once at boot (see init() below; GET
// /settings is in api.js's short-lived GET cache anyway) and cached here
// rather than re-fetched on every navigation.
let cachedSettings = null;

function renderNav() {
  const hash = (location.hash || "#/dashboard").split("?")[0];
  const signature = `${hash}|${getLang()}|${state.user.name}`;
  if (signature !== lastNavSignature) {
    lastNavSignature = signature;
    rebuildNavMarkup(hash);
    rebuildSidebarMarkup(hash);
  }
  applyOrderBadge();
  applyNotificationBadge();
  applyPlanApprovalBadge();
}

// Icons for the sidebar's role-visible quick-action items that aren't
// already one of the 5 core routes (see EXCLUDED_FROM_SIDEBAR below).
// colorClass is the exact same quick-action-icon-* class the Home screen's
// grid uses for this same action (dashboard.js's QUICK_ACTION_ICON) -- the
// two used to diverge (plain glyph here, colored tile there) for the
// identical destination; reusing the same class instead of inventing a
// second palette keeps them looking like the same action everywhere it
// appears, not two different ones.
const SIDEBAR_ITEM_ICON = {
  qa_plan_route: { icon: icons.planDay, colorClass: "quick-action-icon-route" },
  qa_payments: { icon: icons.payment, colorClass: "quick-action-icon-payments" },
  qa_cash_expense: { icon: icons.wallet, colorClass: "quick-action-icon-cash" },
  qa_pricelist: { icon: icons.tag, colorClass: "quick-action-icon-pricelist" },
  qa_warehouse: { icon: icons.box, colorClass: "quick-action-icon-warehouse" },
  qa_delivery: { icon: icons.truck, colorClass: "quick-action-icon-delivery" },
  qa_recorded: { icon: icons.clock, colorClass: "quick-action-icon-recorded" },
  qa_team_performance: { icon: icons.target, colorClass: "quick-action-icon-team" },
  qa_reports: { icon: icons.chart, colorClass: "quick-action-icon-reports" },
  qa_debt_balances: { icon: icons.wallet, colorClass: "quick-action-icon-debt" },
  qa_company_dashboard: { icon: icons.dashboard, colorClass: "quick-action-icon-company" },
  qa_sales: { icon: icons.trendUp, colorClass: "quick-action-icon-sales" },
  qa_bonuses: { icon: icons.gift, colorClass: "quick-action-icon-bonuses" },
};

// qa_check_in and qa_add_customer both jump into #/map (with a query
// param) -- they're "do a thing right now" shortcuts that make sense as
// their own tile on a phone's home screen, not a second, redundant
// destination next to the Map item the sidebar already has.
const EXCLUDED_FROM_SIDEBAR = new Set(["qa_check_in", "qa_add_customer"]);

function rebuildSidebarMarkup(hash) {
  if (!sidebar) return;

  const coreItems = [
    { hash: "#/dashboard", label: t("nav_dashboard"), icon: icons.home },
    { hash: "#/activity", label: t("nav_activity"), icon: icons.activity },
    { hash: "#/map", label: t("nav_map"), icon: icons.map },
    { hash: "#/customers", label: t("nav_customers"), icon: icons.customers },
    { hash: "#/orders", label: t("nav_orders"), icon: icons.cart, badgeId: "sidebar-orders-badge" },
  ];

  const visibleIds = visibleQuickActionIds(state.user.role, cachedSettings?.quick_action_visibility).filter(
    (id) => !EXCLUDED_FROM_SIDEBAR.has(id) && (id !== "qa_bonuses" || cachedSettings?.bonuses_enabled)
  );
  const moreItems = QUICK_ACTIONS.filter((a) => visibleIds.includes(a.id) && QUICK_ACTION_ROUTE[a.id]).map((a) => {
    const entry = SIDEBAR_ITEM_ICON[a.id];
    return {
      hash: QUICK_ACTION_ROUTE[a.id],
      label: t(a.id),
      icon: entry?.icon || icons.chart,
      colorClass: entry?.colorClass,
    };
  });

  function itemHtml(item) {
    const active = hash === item.hash;
    return `
      <button type="button" class="sidebar-item ${active ? "sidebar-item-active" : ""}" data-hash="${item.hash}" ${active ? 'aria-current="page"' : ""}>
        <span class="sidebar-item-icon ${item.colorClass ? `quick-action-icon ${item.colorClass}` : ""}">
          ${item.icon}
          ${item.badgeId ? `<span class="nav-badge count-badge" id="${item.badgeId}" hidden></span>` : ""}
        </span>
        <span>${item.label}</span>
      </button>
    `;
  }

  sidebar.innerHTML = `
    <div class="sidebar-brand">
      <img class="topbar-logo topbar-logo-wordmark" src="/brand/kad-wordmark.png" alt="KAD" />
      <span class="topbar-title">${t("app_name_suffix")}</span>
    </div>
    <nav class="sidebar-nav" aria-label="${t("nav_settings")}">
      ${coreItems.map(itemHtml).join("")}
      ${
        moreItems.length
          ? `<div class="sidebar-section-label">${t("nav_more")}</div>${moreItems.map(itemHtml).join("")}`
          : ""
      }
    </nav>
  `;
  sidebar.querySelectorAll("[data-hash]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.hash === "#/dashboard" ? homeNavTarget() : el.dataset.hash));
  });
}

function rebuildNavMarkup(hash) {
  const items = [
    { hash: "#/dashboard", label: t("nav_dashboard"), icon: icons.home },
    { hash: "#/activity", label: t("nav_activity"), icon: icons.activity },
    { hash: "#/map", label: t("nav_map"), icon: icons.map, center: true },
    { hash: "#/customers", label: t("nav_customers"), icon: icons.customers },
    { hash: "#/orders", label: t("nav_orders"), icon: icons.cart },
  ];

  navBar.innerHTML = items
    .map((item) =>
      item.center
        ? `
      <div class="nav-item-center-wrap">
        <button class="nav-item-center ${hash === item.hash ? "nav-item-center-active" : ""}" data-hash="${item.hash}" aria-label="${item.label}" ${hash === item.hash ? 'aria-current="page"' : ""}>
          <span class="nav-icon-center">${item.icon}</span>
        </button>
        <span class="nav-item-center-label">${item.label}</span>
      </div>
    `
        : `
      <button class="nav-item ${hash === item.hash ? "nav-item-active" : ""}" data-hash="${item.hash}" aria-label="${item.label}" ${hash === item.hash ? 'aria-current="page"' : ""}>
        <span class="nav-icon">
          ${item.icon}
          ${item.hash === "#/orders" ? `<span class="nav-badge count-badge" id="orders-nav-badge" hidden></span>` : ""}
        </span>
        <span>${item.label}</span>
      </button>
    `
    )
    .join("");

  navBar.querySelectorAll("[data-hash]").forEach((el) => {
    el.addEventListener("click", () => navigate(el.dataset.hash === "#/dashboard" ? homeNavTarget() : el.dataset.hash));
  });

  topBar.innerHTML = `
    <span class="topbar-brand">
      <img class="topbar-logo topbar-logo-wordmark" src="/brand/kad-wordmark.png" alt="KAD" />
      <span class="topbar-title">${t("app_name_suffix")}</span>
    </span>
    <div class="topbar-right">
      <span class="topbar-user">${escapeHtml(state.user.name)}</span>
      <button type="button" class="topbar-menu-btn" id="topbar-bell-btn" aria-label="${t("notifications_title")}" ${hash === "#/notifications" ? 'aria-current="page"' : ""}>
        ${icons.bell}
        <span class="nav-badge count-badge" id="topbar-bell-badge" hidden></span>
      </button>
      <button type="button" class="topbar-menu-btn" id="topbar-menu-btn" aria-label="${t("nav_settings")}" ${hash === "#/settings" ? 'aria-current="page"' : ""}>
        ${icons.menu}
        <span class="nav-badge count-badge" id="topbar-menu-badge" hidden></span>
      </button>
    </div>
  `;
  topBar.querySelector("#topbar-bell-btn").addEventListener("click", () => navigate("#/notifications"));
  topBar.querySelector("#topbar-menu-btn").addEventListener("click", () => {
    if (hash === "#/settings") {
      navigate(preSettingsHash);
    } else {
      preSettingsHash = hash;
      navigate("#/settings");
    }
  });
}

function renderSyncBanner() {
  const queue = getQueue();
  const pending = queue.length;
  if (!pending) {
    syncBanner.hidden = true;
    syncBanner.onclick = null;
    syncBanner.onkeydown = null;
    syncBanner.removeAttribute("tabindex");
    syncBanner.setAttribute("role", "status");
    return;
  }
  syncBanner.hidden = false;
  const needsAttention = queue.filter((e) => e.needsAttention).length;
  if (needsAttention) {
    // Stuck items stopped auto-retrying (see offlineQueue.js) -- point the
    // rep at Settings > Data & Sync, the one place with a manual retry
    // control, instead of leaving them wondering why nothing is happening.
    const template = t("sync_needs_attention_banner");
    syncBanner.textContent = template
      .replace("{n}", needsAttention)
      .replace("{s}", needsAttention > 1 ? "s" : "");
    syncBanner.setAttribute("role", "button");
    syncBanner.setAttribute("tabindex", "0");
    syncBanner.onclick = () => navigate("#/settings");
    syncBanner.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        navigate("#/settings");
      }
    };
  } else {
    const template = t(navigator.onLine ? "syncing_checkins" : "offline_checkins_waiting");
    syncBanner.textContent = template
      .replace("{n}", pending)
      .replace("{s}", pending > 1 ? "s" : "");
    syncBanner.onclick = null;
    syncBanner.onkeydown = null;
    syncBanner.removeAttribute("tabindex");
    syncBanner.setAttribute("role", "status");
  }
}

onQueueChange(renderSyncBanner);
window.addEventListener("online", renderSyncBanner);
window.addEventListener("offline", renderSyncBanner);
window.addEventListener("hashchange", render);

// Background session/role refresh when the app regains focus (switching
// back from another app, unlocking the phone) -- catches a role change an
// admin made elsewhere, or a session nearing its 30-day cookie expiry,
// sooner than the next real navigation would happen to notice, without
// ever blocking the UI on it. Throttled so rapid focus/blur (alt-tabbing)
// doesn't turn into a request storm.
let lastFocusRefreshAt = 0;
const FOCUS_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
async function refreshSessionOnFocus() {
  if (!state.user) return;
  const now = Date.now();
  if (now - lastFocusRefreshAt < FOCUS_REFRESH_MIN_INTERVAL_MS) return;
  lastFocusRefreshAt = now;
  try {
    const user = await api.me();
    const roleChanged = user.role !== state.user.role;
    setUser(user);
    if (roleChanged) {
      await clearCacheIfRoleChanged(user);
      render();
    }
  } catch {
    // A genuinely expired/revoked session behaves exactly like any other
    // failed request elsewhere in the app (surfaced inline by whatever the
    // rep does next) -- a background focus check has no form/action of its
    // own to show that error in, and silently forcing a logout here could
    // drop unsaved work on what might just be a transient network blip.
  }
}
window.addEventListener("focus", refreshSessionOnFocus);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshSessionOnFocus();
});

document.addEventListener("invalid", (event) => {
  const field = event.target;
  field.setAttribute("aria-invalid", "true");
  let error = field.parentElement?.querySelector(":scope > .field-error");
  if (!error) {
    error = document.createElement("span");
    error.className = "field-error";
    error.id = `field-error-${++fieldErrorId}`;
    error.setAttribute("role", "alert");
    field.insertAdjacentElement("afterend", error);
  }
  error.textContent = field.validationMessage;
  field.setAttribute("aria-describedby", error.id);
}, true);
document.addEventListener("input", (event) => {
  if (event.target.matches("input, select, textarea") && event.target.validity?.valid) {
    const field = event.target;
    field.removeAttribute("aria-invalid");
    const error = field.parentElement?.querySelector(":scope > .field-error");
    if (error) error.remove();
    field.removeAttribute("aria-describedby");
  }
});

async function init() {
  // Optimistic paint from whatever /api/me last returned successfully, so a
  // slow/high-latency network doesn't leave the screen blank through the
  // two sequential round trips below (lockdown status, then the real
  // /api/me) before it can render anything at all. Set directly on state
  // rather than through setUser() -- this is provisional and hasn't been
  // confirmed, so it shouldn't re-write the cache with a copy of itself.
  // Both checks below still run unconditionally right after and are what
  // actually decide anything security-sensitive: showLockdownOverlay fully
  // replaces this render if lockdown turns out to be engaged (a rare,
  // split-second flash of the ordinary app shell is an acceptable cost for
  // not blocking the common case on it), and the real /api/me response
  // corrects whatever this optimistic one showed if it disagrees (role
  // changed, session gone).
  const cachedUser = loadCachedUser();
  if (cachedUser) {
    state.user = cachedUser;
    render();
  }

  try {
    const lockdownStatus = await api.getLockdownStatus();
    if (lockdownStatus.enabled) {
      const { showLockdownOverlay } = await import("./lockdownScreen.js");
      showLockdownOverlay(lockdownStatus);
      return;
    }
  } catch {
    // Unreachable/offline: fall through to the normal boot path below
    // rather than blocking the whole app on a status check that can't
    // even complete.
  }

  try {
    const user = await api.me();
    setUser(user);
    // Catches a role change (e.g. sales_manager -> sales_director) an admin
    // made while this device stayed signed in -- server-side auth is always
    // correct regardless (requireAuth re-fetches role every request), this
    // is just to stop a stale cached list screen from flashing data scoped
    // to the OLD role's visibility for a moment on next open.
    await clearCacheIfRoleChanged(user);
    startLocationBroadcast();
    startErrorMonitoring();
  } catch {
    setUser(null);
  }
  renderSyncBanner();
  flushQueue();
  render();
  if (state.user) {
    api
      .getSettings()
      .then((settings) => {
        cachedSettings = settings;
        renderNav();
      })
      .catch(() => {});
  }
  refreshOrderBadge();
  refreshPaymentBadge();
  refreshUnrecordedBadge();
  refreshWarehouseBadge();
  refreshDeliveryBadge();
  refreshNotificationBadge();
  refreshPlanApprovalBadge();
  refreshEditRequestBadge();
  // The refresh*Badge() calls just above are the initial, right-at-
  // boot values (each its own single-purpose endpoint, so the very first
  // paint reflects whichever ones this role can even see without waiting
  // on the others). The recurring 60s poll after that uses the combined
  // /badges endpoint instead -- one request updating all the counts,
  // rather than separate fetches landing back to back every minute.
  setInterval(refreshAllBadgesFromServer, 60000);
}

async function refreshAllBadgesFromServer() {
  if (!state.user) return;
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
  deliveryBadgeCount = counts.delivery;
  unreadNotificationCount = counts.notifications;
  planApprovalBadgeCount = counts.planApprovals;
  editRequestBadgeCount = counts.editRequests;
  applyOrderBadge();
  applyPaymentBadge();
  applyUnrecordedBadge();
  applyWarehouseBadge();
  applyDeliveryBadge();
  applyNotificationBadge();
  applyPlanApprovalBadge();
}

initServiceWorkerUpdates();

init();
