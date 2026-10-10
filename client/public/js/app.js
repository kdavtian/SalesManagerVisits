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
import { openSyncQueueSheet } from "./syncQueueSheet.js";
import { getPerfMode } from "./perfMode.js";
import { clearListCache, clearCacheIfRoleChanged } from "./listCache.js";
import { mountInstallPrompt } from "./install.js";
import { mountUpdateBanner, initServiceWorkerUpdates } from "./updateBanner.js";
import { startLocationBroadcast, stopLocationBroadcast } from "./locationBroadcast.js";
import { escapeHtml, takeParkedSheet, pruneParkedSheet, installPhoneMask } from "./util.js";
import { QUICK_ACTIONS, QUICK_ACTION_ROUTE, visibleQuickActionIds } from "./quickActions.js";
import { startErrorMonitoring } from "./errorMonitoring.js";
import { installTouchPrefetch } from "./prefetch.js";

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
// Jumps straight to the top (no smooth animation: on a long list the
// animation itself takes seconds, which read as "slow"). The bar's own
// top padding (the safe-area strip next to the camera / Dynamic Island) is
// part of this element, so a tap there counts too whenever iOS delivers it
// to the page.
topBar.addEventListener("click", (e) => {
  if (e.target.closest("button, a")) return;
  app.scrollTo({ top: 0, behavior: "instant" });
});
// Sheets/overlays close on a click whose target is the backdrop itself. A
// mouse selection that STARTS inside a sheet's input (drag-selecting text,
// or a slightly sloppy click) and is RELEASED over the backdrop produces a
// click whose target is their common ancestor -- the backdrop -- so the
// sheet used to close mid-edit (reported on desktop for Edit customer).
// Swallow a backdrop click unless the press began on the backdrop too.
// Capture phase, so it runs before every overlay's own click listener.
let lastPressTarget = null;
document.addEventListener("pointerdown", (e) => (lastPressTarget = e.target), true);
document.addEventListener(
  "click",
  (e) => {
    const el = e.target;
    if (el instanceof Element && /overlay/.test(el.className?.toString?.() ?? "") && lastPressTarget && lastPressTarget !== el) {
      e.stopPropagation();
    }
  },
  true
);

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

// Back stack: the exact DOM nodes (not a re-render) of the screens most
// recently navigated away from -- up to BACK_STACK_MAX, newest last -- each
// with its scroll position and cleanup function, so returning to one with the
// browser/PWA back button, an edge-swipe, navigate.goBack, or a deep
// multi-step back restores everything exactly as it was: scroll position,
// filter/sort selections, search text, an expanded accordion, all of it,
// since it is literally the same nodes with their listeners intact.
//
// Rules that keep it from ever showing stale or surprising screens:
//   * A drill-down (customer card, order sheet link, ...) pushes the screen
//     being left; Back pops the newest entry (one step, then the next, ...).
//   * Tapping a bottom-nav TAB is a lateral move, not a drill-down: it starts
//     a fresh trail (older entries are disposed), so "customer card -> Orders
//     tab -> Customers tab" still gives a FRESH Customers list instead of one
//     left several hops ago.
//   * An entry that is not the newest is only restored by a genuine history
//     traversal (Back / long-press Back), never by tapping a link or tab.
//   * Only the newest Map entry is kept (Leaflet + GPS watchers are heavy).
// iPhone/iPad keep 10 screens (iPadOS reports itself as a Mac with a touch
// screen); other devices keep 5, since every kept screen is live DOM in memory.
const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const BACK_STACK_MAX = IS_IOS ? 10 : 5;
let renderSeq = 0; // see render()'s safety net
let backStack = []; // [{ hash, nodes: DocumentFragment, cleanup, scrollTop, appClassName, bodyClassName }]
function disposeBackEntry(entry) {
  try {
    entry.cleanup?.();
  } catch {
    // a failing cleanup must not break navigation
  }
}
// Screens kept in the back stack (and a parked sheet) are DOM snapshots drawn
// with whatever language, theme, performance mode, profile or admin settings
// were active when they were left. After a preference change they must be
// thrown away, or Back / the menu icon brings the old language or tiles back
// until the tab is restarted. Fired by Settings (language, theme, performance
// mode, avatar, phone) and by api.updateSettings (admin settings such as the
// Home tile visibility or the Bonuses switch).
// A screen that detects it is broken (e.g. the map drew no tiles) asks for a
// fresh render of the current route.
window.addEventListener("app-rerender", () => {
  if (state.user) render();
});

window.addEventListener("app-preferences-changed", () => {
  backStack.forEach(disposeBackEntry);
  backStack = [];
  pruneParkedSheet([]);
  lastNavSignature = null; // rebuild the tab bar, top bar and sidebar
  if (!state.user) return;
  // Admin-configurable settings (quick-action tiles, Bonuses switch) feed the
  // desktop sidebar from this copy, which was only loaded at boot.
  api
    .getSettings()
    .then((settings) => {
      cachedSettings = settings;
      lastNavSignature = null;
      renderNav();
    })
    .catch(() => {});
  renderNav();
});

function trimBackStack() {
  let sawMap = false;
  for (let i = backStack.length - 1; i >= 0; i--) {
    if (!backStack[i].hash.startsWith("#/map")) continue;
    if (sawMap) {
      disposeBackEntry(backStack[i]);
      backStack.splice(i, 1);
    } else sawMap = true;
  }
  while (backStack.length > BACK_STACK_MAX) disposeBackEntry(backStack.shift());
}
// True for a hash change this app made itself (navigate()); anything else
// (browser Back/Forward, edge swipe) is a history traversal.
let programmaticNav = false;
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

// Tapping the tab you are already on: the first tap jumps back to the top of
// the screen, a second tap within a second RESTARTS the tab (a fresh render
// with default filters and fresh data) -- the usual "tap the tab twice to
// refresh" gesture. A single tap never reloads, so an accidental tap costs
// nothing. Tapping any other tab navigates as before.
let lastActiveTabTap = { hash: "", at: 0 };
function handleNavTap(target) {
  const targetBase = target.split("?")[0];
  const currentBase = (location.hash || "#/dashboard").split("?")[0];
  if (currentBase !== targetBase || !NAV_TAB_ROOT_HASHES.has(targetBase)) {
    navigate(target);
    return;
  }
  const now = Date.now();
  if (lastActiveTabTap.hash === targetBase && now - lastActiveTabTap.at < 1000) {
    lastActiveTabTap = { hash: "", at: 0 };
    render();
    return;
  }
  lastActiveTabTap = { hash: targetBase, at: now };
  app.scrollTo({ top: 0, behavior: "instant" });
}

function homeNavTarget() {
  const currentPath = (location.hash || "#/dashboard").split("?")[0];
  return HOME_TREE_ROUTES.has(currentPath) ? "#/dashboard" : lastHomeHash;
}

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
  persistBadgeCounts();
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

async function refreshUnrecordedBadge() {
  if (!state.user || !["accountant", "ceo", "operations_director", "admin"].includes(state.user.role)) return;
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
  persistBadgeCounts();
}

window.addEventListener("warehouse-changed", refreshWarehouseBadge);

// Same pattern again, on the Accounting quick action -- requests Lily has not
// finished (accounting roles) or orders whose document is ready (warehouse);
// 0 for everyone else (see server/src/accountingBadge.js). The Accounting
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

async function refreshAccountingBadge() {
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
  persistBadgeCounts();
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

async function refreshPlanApprovalBadge() {
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

async function refreshEditRequestBadge() {
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

// Tracks whether this SPA session has done at least one in-app navigation
// (as opposed to just rendering whatever hash the app happened to boot
// into, e.g. a deep link or a notification tap straight into a detail
// page). Lets a "back" button distinguish "there's a real previous screen
// in this tab's history I can return to" from "there isn't, so jump to a
// sensible default instead" -- see navigate.goBack below.
let hasNavigatedInApp = false;

// Back animation (owner's choice: an animation, no live preview): a sheet in the page colour that
// covers the content area and slides off to the right, like iOS pops a screen. Purely visual
// (pointer-events none), skipped with "reduce motion" and in efficiency mode.
function playBackSlide() {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || getPerfMode() === "efficiency") return;
  const rect = app.getBoundingClientRect();
  const sheet = document.createElement("div");
  sheet.className = "back-slide-sheet";
  sheet.style.cssText = `top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px`;
  document.body.appendChild(sheet);
  const remove = () => sheet.remove();
  sheet.addEventListener("animationend", remove, { once: true });
  setTimeout(remove, 700); // never leave it behind
}

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
  programmaticNav = true;
  setTimeout(() => (programmaticNav = false), 800);
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

// ---- Render safety net --------------------------------------------------
// A view that throws while mounting (or a lazily imported view module that
// fails to load -- stale service-worker cache after a deploy, a dropped
// connection, a killed tab process) used to leave #app EMPTY: a white screen
// with no way out except force-quitting the app. Now render() catches that,
// shows a "Reload" card instead, reloads once by itself when it was a module
// load failure, and a watchdog catches a screen that stays empty without any
// error at all.
function appIsBlank() {
  return !app.querySelector("*");
}
function showRenderFailure(err) {
  console.error("Screen failed to render:", err);
  if (!appIsBlank()) return;
  const message = String(err?.message || err || "");
  const moduleLoadFailure = /dynamically imported module|Importing a module script failed|Failed to fetch|Load failed/i.test(message);
  try {
    const last = Number(sessionStorage.getItem("fv_render_reload") || 0);
    if (moduleLoadFailure && Date.now() - last > 60000) {
      sessionStorage.setItem("fv_render_reload", String(Date.now()));
      location.reload();
      return;
    }
  } catch {
    // sessionStorage unavailable -- fall through to the card
  }
  app.innerHTML = `
    <div class="detail-view render-failed">
      <div class="card">
        <h2>${t("render_failed_title")}</h2>
        <p class="muted">${t("render_failed_body")}</p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="render-failed-home">${t("nav_dashboard")}</button>
          <button type="button" class="btn btn-primary" id="render-failed-reload">${t("reload_app")}</button>
        </div>
      </div>
    </div>`;
  app.querySelector("#render-failed-reload").addEventListener("click", () => location.reload());
  app.querySelector("#render-failed-home").addEventListener("click", () => {
    location.hash = "#/dashboard";
    location.reload();
  });
}
async function render() {
  const seq = ++renderSeq;
  try {
    await renderRoute();
  } catch (err) {
    showRenderFailure(err);
  }
  // Watchdog: a view that neither threw nor painted anything.
  setTimeout(() => {
    if (seq === renderSeq && appIsBlank()) showRenderFailure(new Error("Screen stayed empty"));
  }, 8000);
}
window.addEventListener("unhandledrejection", (e) => {
  if (appIsBlank()) showRenderFailure(e.reason);
});
window.addEventListener("error", (e) => {
  if (appIsBlank()) showRenderFailure(e.error || e.message);
});
// Coming back from the background (or the back/forward cache) to an empty
// page: re-mount the current screen instead of showing white.
function recoverBlankScreen() {
  if (document.visibilityState === "visible" && state.user && appIsBlank()) render();
}
document.addEventListener("visibilitychange", recoverBlankScreen);
window.addEventListener("pageshow", recoverBlankScreen);

async function renderRoute() {
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
    backStack.forEach(disposeBackEntry);
    backStack = [];
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
      refreshAccountingBadge();
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
  const isHistory = !programmaticNav;
  programmaticNav = false;
  let matchIdx = -1;
  for (let i = backStack.length - 1; i >= 0; i--) {
    if (backStack[i].hash === hash) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx >= 0 && (matchIdx === backStack.length - 1 || isHistory)) {
    if (currentCleanup) {
      currentCleanup();
      currentCleanup = null;
    }
    // Screens opened after the one we are returning to are being unwound.
    backStack.splice(matchIdx + 1).forEach(disposeBackEntry);
    const { nodes, cleanup, scrollTop, appClassName, bodyClassName } = backStack.pop();
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
    // A real Back (button or edge swipe) to a screen we left: slide the page we came from away.
    if (isHistory) playBackSlide();
    requestAnimationFrame(() => {
      app.scrollTop = scrollTop;
    });
    // A restored view's DOM/closures are exactly as they were when the
    // user left -- including whatever data they rendered with, which may
    // no longer be current (e.g. map.js's markers after an edit made on a
    // customer detail page visited in between). A view that cares opts in
    // by attaching an onRestore() hook to its cleanup function; one that
    // doesn't need this is unaffected.
    currentCleanup?.onRestore?.();
    // Back from a screen that a sheet's link opened: put that sheet back.
    const parked = takeParkedSheet(hash);
    if (parked) document.body.appendChild(parked);
    return;
  }

  // Not restoring: whatever is currently mounted is about to be replaced.
  // Stash it into the single back-cache slot first (so a subsequent "back"
  // to exactly this hash is instant) unless there's nothing to stash (first
  // paint) or we're already on this exact hash (a re-render of the same
  // route, e.g. after a settings change). A stale, unconsumed cache entry
  // from an earlier hop is disposed here rather than silently dropped, so
  // whatever cleanup it owned (a timer, a geolocation watch) still runs.
  // A tab switch is a lateral move: start a fresh trail (see the back-stack
  // comment above). A cached copy of the screen we are about to render fresh
  // would only be stale, so it is disposed too.
  if (NAV_TAB_ROOT_HASHES.has(hash.split("?")[0]) && !isHistory) {
    backStack.forEach(disposeBackEntry);
    backStack = [];
  }
  backStack = backStack.filter((entry) => {
    if (entry.hash !== hash) return true;
    disposeBackEntry(entry);
    return false;
  });
  if (isHistory && lastRenderedHash && lastRenderedHash !== hash && app.firstChild && matchIdx < 0 && backStack.length === 0) {
    // History traversal to a screen we hold no copy of, with nothing cached:
    // keep the trail as it is rather than caching the screen we leave.
    if (currentCleanup) {
      currentCleanup();
      currentCleanup = null;
    }
  } else if (lastRenderedHash && lastRenderedHash !== hash && app.firstChild) {
    // Captured BEFORE emptying #app below -- a scroll container with no
    // children always reports scrollTop 0, so reading it after the move
    // loop would silently throw away the real position every time.
    const scrollTopSnapshot = app.scrollTop;
    const appClassNameSnapshot = app.className;
    const bodyClassNameSnapshot = document.body.className;
    const fragment = document.createDocumentFragment();
    while (app.firstChild) fragment.appendChild(app.firstChild);
    backStack.push({
      hash: lastRenderedHash,
      nodes: fragment,
      cleanup: currentCleanup,
      scrollTop: scrollTopSnapshot,
      appClassName: appClassNameSnapshot,
      bodyClassName: bodyClassNameSnapshot,
    });
    currentCleanup = null; // ownership transferred to the back stack
    trimBackStack();
    // The outgoing view's cleanup function -- the only thing that would
    // normally strip any #app/document.body classes it added at mount
    // time -- isn't going to run until its entry is evicted, which may be
    // much later or never. The next view must not inherit them (e.g.
    // mounting a checkin page under map.js's scroll-locking class), so
    // reset to the true baseline now; restoring that entry later reapplies
    // its own snapshot.
    app.className = baseAppClassName;
    document.body.className = baseBodyClassName;
  } else if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }
  // A parked sheet only survives while the screen it was opened on is the one
  // sitting in the back-cache.
  pruneParkedSheet(backStack.map((entry) => entry.hash));
  lastRenderedHash = hash;

  const [path, queryString] = hash.split("?");
  if (path !== currentPath) {
    currentPath = path;
    requestAnimationFrame(() => app.focus({ preventScroll: true }));
  }
  const query = new URLSearchParams(queryString || "");
  const customerMatch = path.match(/^#\/customers\/(\d+)$/);
  const productMatch = path.match(/^#\/product\/(\d+)$/);
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
  } else if (path === "#/route-distribution") {
    (await import("./views/routeDistribution.js")).renderRouteDistribution(app, navigate);
  } else if (path === "#/route-plans") {
    (await import("./views/routePlans.js")).renderRoutePlans(app, navigate);
  } else if (path === "#/team-performance") {
    (await import("./views/teamPerformance.js")).renderTeamPerformance(app, navigate, query);
  } else if (path === "#/company-dashboard") {
    (await import("./views/dashboardOverview.js")).renderDashboardOverview(app, navigate);
  } else if (path === "#/pricelist") {
    (await import("./views/pricelist.js")).renderPricelist(app, navigate);
  } else if (productMatch) {
    (await import("./views/productDetail.js")).renderProductDetail(app, navigate, productMatch[1]);
  } else if (path === "#/warehouse") {
    (await import("./views/warehouse.js")).renderWarehouse(app, navigate);
  } else if (path === "#/delivery") {
    (await import("./views/deliveryRoute.js")).renderDelivery(app, navigate);
  } else if (path === "#/accounting") {
    (await import("./views/accounting.js")).renderAccounting(app, navigate);
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
  } else if (path === "#/tasks") {
    (await import("./views/tasks.js")).renderTasks(app, navigate, query.get("open"));
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
  qa_accounting: { icon: icons.note, colorClass: "quick-action-icon-accounting" },
  qa_team_performance: { icon: icons.target, colorClass: "quick-action-icon-team" },
  qa_reports: { icon: icons.chart, colorClass: "quick-action-icon-reports" },
  qa_debt_balances: { icon: icons.wallet, colorClass: "quick-action-icon-debt" },
  qa_company_dashboard: { icon: icons.dashboard, colorClass: "quick-action-icon-company" },
  qa_sales: { icon: icons.trendUp, colorClass: "quick-action-icon-sales" },
  qa_tasks: { icon: icons.tasks, colorClass: "quick-action-icon-tasks" },
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
    el.addEventListener("click", () => handleNavTap(el.dataset.hash === "#/dashboard" ? homeNavTarget() : el.dataset.hash));
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
    el.addEventListener("click", () => handleNavTap(el.dataset.hash === "#/dashboard" ? homeNavTarget() : el.dataset.hash));
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
    syncBanner.classList.remove("sync-banner-link");
    return;
  }
  syncBanner.hidden = false;
  const needsAttention = queue.filter((e) => e.needsAttention).length;
  // Either way the banner opens the "waiting to send" sheet (what is queued, retry now, discard a
  // stuck item); stuck items keep the red button look from before.
  const template = needsAttention ? t("sync_needs_attention_banner") : t(navigator.onLine ? "syncing_checkins" : "offline_checkins_waiting");
  const count = needsAttention || pending;
  // "{s}" is the English plural ending only; the Armenian texts have none.
  syncBanner.textContent = template.replace("{n}", count).replace("{s}", count > 1 && getLang() !== "hy" ? "s" : "");
  syncBanner.setAttribute("role", "button");
  syncBanner.setAttribute("tabindex", "0");
  syncBanner.classList.toggle("sync-banner-link", !needsAttention);
  syncBanner.onclick = openSyncQueueSheet;
  syncBanner.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openSyncQueueSheet();
    }
  };
}

onQueueChange(renderSyncBanner);
window.addEventListener("online", renderSyncBanner);
window.addEventListener("offline", renderSyncBanner);
installPhoneMask(); // "+374 91 007 019" typing mask on every phone field
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
  installTouchPrefetch();
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
  let optimisticRenderDone = false;
  if (cachedUser) {
    state.user = cachedUser;
    // Same optimistic-paint reasoning as cachedUser above, applied to the
    // quick-action tile badges specifically -- without this, every one of
    // them starts this render at 0/hidden (see the module-level `let
    // ...BadgeCount = 0` declarations below) regardless of what was last
    // known, since none of that is cached anywhere else.
    const cachedBadgeCounts = loadCachedBadgeCounts();
    if (cachedBadgeCounts) {
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
    render();
    optimisticRenderDone = true;
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

  // Whether the confirmed /api/me response below changes anything the
  // optimistic render above already painted correctly -- if it's the same
  // account and the same role, the mounted view, nav, and badges are
  // already right, and a redundant render() here would discard that
  // already-correct paint and rebuild from scratch for nothing. Most
  // routed views (renderDashboard included) wipe their container to a
  // bare loading placeholder before repainting, so that redundant render
  // was exactly what made a cold open look like "opens correctly, then
  // flashes to a loading state, then redraws" -- the optimistic paint
  // disappearing and reappearing read as a refresh.
  let skipRedundantRender = false;
  try {
    const user = await api.me();
    skipRedundantRender = optimisticRenderDone && cachedUser && cachedUser.id === user.id && cachedUser.role === user.role;
    setUser(user);
    // Catches a role change (e.g. sales_manager -> sales_director) an admin
    // made while this device stayed signed in -- server-side auth is always
    // correct regardless (requireAuth re-fetches role every request), this
    // is just to stop a stale cached list screen from flashing data scoped
    // to the OLD role's visibility for a moment on next open. A no-op here
    // whenever skipRedundantRender is true, since that already means the
    // role didn't change.
    await clearCacheIfRoleChanged(user);
    startLocationBroadcast();
    startErrorMonitoring();
  } catch {
    setUser(null);
  }
  renderSyncBanner();
  flushQueue();
  if (!skipRedundantRender) render();
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
  refreshAccountingBadge();
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

initServiceWorkerUpdates();

init();
