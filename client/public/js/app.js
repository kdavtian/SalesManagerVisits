import { api } from "./api.js";
import { forgetView, restoreScroll, saveView, viewToReopen } from "./viewMemory.js";
import { APP_VERSION } from "./version.js";
import { refreshOrderBadge, refreshPaymentBadge, refreshUnrecordedBadge, refreshWarehouseBadge, refreshAccountingBadge, refreshDeliveryBadge, refreshNotificationBadge, refreshPlanApprovalBadge, refreshEditRequestBadge, refreshAllBadgesFromServer, restoreCachedBadgeCounts } from "./badges.js";
import { state, setUser, loadCachedUser } from "./state.js";
import { t } from "./i18n.js";
import { SLOW_MS, showSlowBar, hideSlowBar, cleanReload, noteLoadFailure } from "./shell/slowRoute.js";

// The module's variables, for its parts in other files (read and written through getters / setters, so they always see the current value).
const ctx = {
  get applySidebarMode() { return applySidebarMode; },
  get cachedSettings() { return cachedSettings; },
  get handleNavTap() { return handleNavTap; },
  get homeNavTarget() { return homeNavTarget; },
  get lastNavSignature() { return lastNavSignature; }, set lastNavSignature(v) { lastNavSignature = v; },
  get navBar() { return navBar; },
  get navigate() { return navigate; },
  get preSettingsHash() { return preSettingsHash; }, set preSettingsHash(v) { preSettingsHash = v; },
  get rebuildNavMarkup() { return rebuildNavMarkup; },
  get rebuildSidebarMarkup() { return rebuildSidebarMarkup; },
  get shellTabs() { return shellTabs; },
  get sidebar() { return sidebar; },
  get syncNavActive() { return syncNavActive; },
  get topBar() { return topBar; },
  get app() { return app; },
  get backStack() { return backStack; }, set backStack(v) { backStack = v; },
  get baseAppClassName() { return baseAppClassName; },
  get baseBodyClassName() { return baseBodyClassName; },
  get currentCleanup() { return currentCleanup; }, set currentCleanup(v) { currentCleanup = v; },
  get currentPath() { return currentPath; }, set currentPath(v) { currentPath = v; },
  get disposeBackEntry() { return disposeBackEntry; },
  get disposeParkedMap() { return disposeParkedMap; },
  get doLogout() { return doLogout; },
  get HOME_TREE_ROUTES() { return HOME_TREE_ROUTES; },
  get IS_IOS() { return IS_IOS; },
  get installRoot() { return installRoot; },
  get isModalMapFlow() { return isModalMapFlow; },
  get lastHomeHash() { return lastHomeHash; }, set lastHomeHash(v) { lastHomeHash = v; },
  get lastRenderedHash() { return lastRenderedHash; }, set lastRenderedHash(v) { lastRenderedHash = v; },
  get NAV_TAB_ROOT_HASHES() { return NAV_TAB_ROOT_HASHES; },
  get parkedMap() { return parkedMap; }, set parkedMap(v) { parkedMap = v; },
  get parkMap() { return parkMap; },
  get programmaticNav() { return programmaticNav; }, set programmaticNav(v) { programmaticNav = v; },
  get render() { return render; },
  get renderNav() { return renderNav; },
  get renderSeq() { return renderSeq; },
  get STALE_ROUTE() { return STALE_ROUTE; },
  get trimBackStack() { return trimBackStack; },
};

// iOS Safari only applies :active (the pressed look of every button) once the page has a touch listener; without
// it a tap shows no pressed state at all. A passive no-op listener on the document is enough.
document.addEventListener("touchstart", () => {}, { passive: true });

// Number fields (amounts, days, percentages, quantities): tapping one EMPTIES it and keeps the old number visible as a
// faint "ghost" (the placeholder), so the person types the new number straight away and still sees what it was.
// Nothing is lost by accident: if they type nothing, the old number comes back when they leave the field -- and
// BEFORE anything else reacts to a tap or Enter elsewhere (iOS does not blur a field when a button is tapped, so the
// value is restored on the pointer-down, not only on blur). No `input` event is fired for the clearing, so totals
// and previews keep showing the old number until something is really typed.
let ghosted = null; // { el, value, placeholder, touched }
function restoreGhost() {
  if (!ghosted) return;
  const { el, value, placeholder, touched } = ghosted;
  ghosted = null;
  el.classList.remove("ghost-active");
  if (placeholder === null) el.removeAttribute("placeholder");
  else el.setAttribute("placeholder", placeholder);
  if (!touched && el.value === "") el.value = value;
}
const isGhostField = (el) =>
  el instanceof HTMLInputElement &&
  !el.readOnly &&
  !el.disabled &&
  (el.classList.contains("amd-input") || el.classList.contains("oc-field") || el.type === "number" || el.inputMode === "numeric" || el.inputMode === "decimal");
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (ghosted && ghosted.el !== el) restoreGhost();
  if (!isGhostField(el) || el.value === "" || ghosted?.el === el) return;
  ghosted = { el, value: el.value, placeholder: el.getAttribute("placeholder"), touched: false };
  el.setAttribute("placeholder", el.value);
  el.classList.add("ghost-active");
  el.value = "";
});
document.addEventListener("focusout", (e) => {
  if (ghosted?.el === e.target) restoreGhost();
});
document.addEventListener("input", (e) => {
  if (ghosted?.el === e.target) ghosted.touched = true;
});
document.addEventListener(
  "pointerdown",
  (e) => {
    if (ghosted && e.target !== ghosted.el) restoreGhost();
  },
  true
);
document.addEventListener(
  "keydown",
  (e) => {
    if (ghosted && e.key === "Enter") restoreGhost();
  },
  true
);
// Every view module below is loaded on demand (dynamic import()) from
// render()'s route dispatch instead of statically here -- on boot, only the
// screen the user actually lands on needs to be fetched/parsed/evaluated,
// not all ~24 of them. The browser's module cache means each is still only
// fetched once per session (revisiting a route is instant, same as a static
// import would have been); this only changes when the fetch happens, not
// how often. This mirrors the dynamic-import pattern already used elsewhere
// in this codebase for cross-view references (e.g. customerOrders.js's own
// import("./customerDetail.js")).
import { flushQueue, onQueueChange } from "./offlineQueue.js";
import { startVaghinakWatch } from "./vaghinak.js";
import { clearListCache, clearCacheIfRoleChanged } from "./listCache.js";
import { mountUpdateBanner, initServiceWorkerUpdates, isUpdatePending } from "./updateBanner.js";
import { startLocationBroadcast, stopLocationBroadcast } from "./locationBroadcast.js";
import { startDriverArrival, stopDriverArrival } from "./driverArrival.js";
import { pruneParkedSheet, installPhoneMask } from "./util.js";
import { QUICK_ACTION_ROUTE } from "./quickActions.js";
import { installStatusBarTap } from "./statusBarTap.js";
import { startErrorMonitoring } from "./errorMonitoring.js";
import { installTouchPrefetch } from "./prefetch.js";
import "./deskHover.js"; // desktop: full text of a cut-off cell on hover (roadmap step 9)
import { runWhenIdle } from "./shell/preload.js";
import { renderSyncBanner } from "./shell/syncBanner.js";
import * as shellNav from "./shell/nav.js";
import * as shellRoutes from "./shell/routes.js";
import { markFirstScreenShown } from "./launchTiming.js";
import { loadOtherStylesSoon } from "./styles.js";
import { dropTabTrails, switchTab } from "./shell/tabs.js";

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
installStatusBarTap();
// Esc closes the top-most sheet or docked panel, wherever the focus is (docs/desktop-roadmap.md, step 4). A sheet's own Esc
// (activateDialog), a menu or the top-bar search handle it first and mark the event, so one press closes one thing.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (e.target.closest?.("[role=menu], .activity-search-menu, .dropdown-menu")) return;
  const overlays = document.querySelectorAll(".sheet-overlay");
  const top = overlays[overlays.length - 1];
  if (!top) return;
  e.preventDefault();
  top.remove();
});
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
// so it still has to check. Deferred to idle time (runWhenIdle, shell/preload.js) so
// this bookkeeping never competes with the same-frame work of the render
// that triggered it -- the assistive-tech announcement lands a beat later,
// not the visible UI.
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
// iPhone: 30 pages (owner, 2026-10-30: "for iphone raise the limit to 30 pages and all tabs"); every other device keeps 5.
const BACK_STACK_MAX = IS_IOS ? 30 : 5;
let renderSeq = 0; // see render()'s safety net
let backStack = []; // [{ hash, nodes: DocumentFragment, cleanup, scrollTop, appClassName, bodyClassName }]
function disposeBackEntry(entry) {
  try {
    entry.cleanup?.();
  } catch {
    // a failing cleanup must not break navigation
  }
}
// The Map tab is kept alive across tab switches (owner, 2026-10-26: "Map is loading each time I switch tabs"): leaving it for another
// tab parks the same DOM / Leaflet instance here (the back stack is wiped at every tab switch), and coming back to a plain #/map puts
// it back as it was -- pan, zoom, filters -- instead of building it again. While parked its location watch and team poll are paused.
let parkedMap = null;
function disposeParkedMap() {
  if (!parkedMap) return;
  disposeBackEntry(parkedMap);
  parkedMap = null;
}
function parkMap(entry) {
  if (parkedMap && parkedMap !== entry) disposeParkedMap();
  parkedMap = entry;
  try {
    entry.cleanup?.onPark?.();
  } catch {
    // pausing is best effort
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
  dropTabTrails(ctx);
  disposeParkedMap();
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

// "Change this customer's location" / "add a customer" maps are one-way flows with a frozen pin and open panels; a
// cached copy of one would come back mid-flow on Back ("shows the change location page again").
const isModalMapFlow = (hash) => /^#\/map\?(?:.*&)?(?:relocate|add)=/.test(hash);

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
const NAV_TAB_ROOT_HASHES = new Set(["#/dashboard", "#/activity", "#/map", "#/customers", "#/orders", "#/wh-pack", "#/pricelist", "#/tasks", "#/delivery"]);

// Tapping the tab you are already on: the first tap jumps back to the top of
// the screen, a second tap within a second RESTARTS the tab (a fresh render
// with default filters and fresh data) -- the usual "tap the tab twice to
// refresh" gesture. A single tap never reloads, so an accidental tap costs
// nothing. Tapping any other tab navigates as before.
let lastActiveTabTap = { hash: "", at: 0 };
// `tab` is the tab tapped (its own address; the Home tab's target can be a screen inside Home): another tab comes back with its
// pages as they were left (shell/tabs.js), or opens fresh when it has none kept.
function handleNavTap(target, tab = target.split("?")[0]) {
  const targetBase = target.split("?")[0];
  const currentBase = (location.hash || "#/dashboard").split("?")[0];
  if (currentBase !== targetBase || !NAV_TAB_ROOT_HASHES.has(targetBase)) {
    if (switchTab(ctx, tab)) return;
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


// Tracks whether this SPA session has done at least one in-app navigation
// (as opposed to just rendering whatever hash the app happened to boot
// into, e.g. a deep link or a notification tap straight into a detail
// page). Lets a "back" button distinguish "there's a real previous screen
// in this tab's history I can return to" from "there isn't, so jump to a
// sensible default instead" -- see navigate.goBack below.
let hasNavigatedInApp = false;

// No back animation of our own: iOS/Android already animate the edge-swipe back, and a second page-coloured sheet sliding over the
// restored screen showed up as a "ghost" of the card just closed (owner, 2026-10-26). The restored screen simply appears, at once.

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
    // manually -- render() below is one listener, and views/orders.js (the
    // region filter) registers its own route-driven hashchange listener
    // too; both need to run exactly as they would for a normal push navigation.
    history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  location.hash = hash;
}

// Leaving a flow that must not be reachable again with Back (relocating a customer, adding one): the flow's own
// history entry is REPLACED by the screen it ends on, so Back skips it instead of reopening "change location".
navigate.replace = (hash) => {
  if (location.hash === hash) return;
  hasNavigatedInApp = true;
  programmaticNav = true;
  setTimeout(() => (programmaticNav = false), 800);
  history.replaceState(null, "", hash);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
};
// The screen on display stays mounted but its route changes (a finished add-customer flow is now just "the map
// focused on the new customer"): rewrite the address bar and the router's idea of the current hash, no re-render.
navigate.rewrite = (hash) => {
  if (location.hash === hash) return;
  history.replaceState(null, "", hash);
  lastRenderedHash = hash;
};

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
  forgetView();
  await api.logout();
  setUser(null);
  stopLocationBroadcast();
  stopDriverArrival();
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
const MODULE_LOAD_FAILURE = /dynamically imported module|Importing a module script failed|Failed to fetch|Load failed|does not provide an export|Importing binding name|is not found/i;
const isModuleLoadFailure = (err) => MODULE_LOAD_FAILURE.test(String(err?.message || err || ""));
function showRenderFailure(err) {
  console.error("Screen failed to render:", err);
  // Scripts of two versions meeting (an update arrived while the app was open) or a file that did not download: one reload fixes it,
  // so do it by itself -- whether or not something is still on screen.
  const moduleLoadFailure = isModuleLoadFailure(err);
  noteLoadFailure();
  // Said to the server too, with the file it was about: a failure that only the person saw could not be found afterwards.
  api.reportClientError({ kind: "error", message: `Screen failed (${location.hash || "#/dashboard"}; app ${APP_VERSION}): ${String(err?.message || err)}`.slice(0, 1500), url: location.href }).catch(() => {});
  try {
    const last = Number(sessionStorage.getItem("fv_render_reload") || 0);
    if (moduleLoadFailure && Date.now() - last > 60000) {
      sessionStorage.setItem("fv_render_reload", String(Date.now()));
      // A plain reload kept the same stored copy that had just failed (owner, 2026-10-30): start clean instead.
      cleanReload();
      return;
    }
  } catch {
    // sessionStorage unavailable -- fall through to the card
  }
  if (!appIsBlank()) return;
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
  app.querySelector("#render-failed-reload").addEventListener("click", cleanReload);
  app.querySelector("#render-failed-home").addEventListener("click", () => {
    location.hash = "#/dashboard";
    location.reload();
  });
}
const STALE_ROUTE = new Error("stale route");
async function render() {
  const seq = ++renderSeq;
  // A screen that has not appeared after a few seconds: a bar with Reload / Clean reload, and the step it hung on is reported.
  const opening = { hash: location.hash || "#/dashboard", startedAt: Date.now() };
  const slowTimer = setTimeout(() => {
    if (seq === renderSeq) showSlowBar({ ...opening, stage: ctx.routeStage || "start" });
  }, SLOW_MS);
  try {
    await renderRoute();
    if (seq === renderSeq) {
      hideSlowBar();
      document.documentElement.dataset.fvBooted = "1"; // bootGate.js: the app did start
      restoreScroll(app, ctx.lastRenderedHash || location.hash); // a reopened screen goes back to where it was scrolled (viewMemory.js)
      markFirstScreenShown();
      loadOtherStylesSoon();
    }
  } catch (err) {
    if (err === STALE_ROUTE) return;
    hideSlowBar();
    showRenderFailure(err);
  } finally {
    clearTimeout(slowTimer);
  }
  // Watchdog: a view that neither threw nor painted anything.
  setTimeout(() => {
    if (seq === renderSeq && appIsBlank()) showRenderFailure(new Error("Screen stayed empty"));
  }, 8000);
}
window.addEventListener("unhandledrejection", (e) => {
  // After an update the person put off ("Later"), a sheet or part not opened yet cannot load any more: the deploy build names its shared
  // files by their content, so this page's old files are gone from the server. One reload (at most once a minute) brings the new version.
  if (appIsBlank() || (isUpdatePending() && isModuleLoadFailure(e.reason))) showRenderFailure(e.reason);
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

function renderRoute(...args) { return shellRoutes.renderRoute(ctx, ...args); }

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

function syncNavActive(...args) { return shellNav.syncNavActive(ctx, ...args); }

function renderNav(...args) { return shellNav.renderNav(ctx, ...args); }

function applySidebarMode(...args) { return shellNav.applySidebarMode(ctx, ...args); }
window.matchMedia?.("(max-width: 1279px)").addEventListener?.("change", applySidebarMode);

function rebuildSidebarMarkup(...args) { return shellNav.rebuildSidebarMarkup(ctx, ...args); }

function shellTabs(...args) { return shellNav.shellTabs(ctx, ...args); }

function rebuildNavMarkup(...args) { return shellNav.rebuildNavMarkup(ctx, ...args); }

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
window.addEventListener("online", refreshSessionOnFocus); // an app opened without network confirms the session once it is back
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
    // A fresh start (the phone closed the app, an update reloaded it) opens the screen the person was on, not Home (viewMemory.js).
    const reopen = viewToReopen(cachedUser.id, location.hash);
    if (reopen) history.replaceState(null, "", reopen);
    // Same optimistic-paint reasoning as cachedUser above, applied to the
    // quick-action tile badges specifically -- without this, every one of
    // them starts this render at 0/hidden (see the module-level `let
    // ...BadgeCount = 0` declarations in badges.js) regardless of what was last
    // known, since none of that is cached anywhere else.
    restoreCachedBadgeCounts();
    render();
    optimisticRenderDone = true;
  }

  // Started together with the lockdown check, not after it: the two used to
  // run back to back, so a cold open waited two full round trips before it
  // knew whether to show the login form. Lockdown still decides first (its
  // overlay replaces everything, and the /me result is then ignored).
  const mePromise = api.me();
  mePromise.catch(() => {});
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
    const user = await mePromise;
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
    startDriverArrival(navigate);
    startErrorMonitoring();
  } catch (err) {
    // Only the server's answer "not signed in / not allowed" (401, 403) signs out. No network, a timeout or a server error is not a
    // sign-out: a rep opening the app without signal used to land on the login screen with the saved user deleted, locked out of the
    // offline lists and the offline order queue until the signal came back (found by the iPhone browser tests, 1.471.0). Keep the saved
    // user and the screen already drawn; the server still checks the session on every request, and the next focus re-asks /api/me.
    if (err?.status === 401 || err?.status === 403 || !cachedUser) {
      setUser(null);
    } else {
      skipRedundantRender = optimisticRenderDone;
      startLocationBroadcast();
      startDriverArrival(navigate);
      startErrorMonitoring();
    }
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
  startVaghinakWatch();
  // The refresh*Badge() calls just above are the initial, right-at-
  // boot values (each its own single-purpose endpoint, so the very first
  // paint reflects whichever ones this role can even see without waiting
  // on the others). The recurring 60s poll after that uses the combined
  // /badges endpoint instead -- one request updating all the counts,
  // rather than separate fetches landing back to back every minute.
  // Not while the app is in the background (no one sees the numbers, and it costs battery and data); the badges are
  // refreshed the moment the app comes back to the front.
  setInterval(() => {
    if (document.visibilityState !== "hidden") refreshAllBadgesFromServer();
  }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshAllBadgesFromServer();
  });
  // A rep tapped Call in a call task: when the app is shown again, ask how the call went (callTask.js).
  const checkPendingCall = () => {
    if (!state.user || document.visibilityState === "hidden") return;
    try {
      if (!localStorage.getItem("fv_pending_call")) return;
    } catch {
      return;
    }
    import("./callTask.js").then((m) => m.resumePendingCall()).catch(() => {});
  };
  document.addEventListener("visibilitychange", checkPendingCall);
  window.addEventListener("pageshow", checkPendingCall);
  window.addEventListener("focus", checkPendingCall);
  setTimeout(checkPendingCall, 2500);
  // iOS home-screen apps do not always report "visible" when they wake from the lock screen or come back online.
  window.addEventListener("focus", () => refreshAllBadgesFromServer());
  window.addEventListener("pageshow", () => refreshAllBadgesFromServer());
  window.addEventListener("online", () => refreshAllBadgesFromServer());
}

initServiceWorkerUpdates();

// Where the person is, saved whenever the app goes to the background and now and then while it is open (viewMemory.js).
function saveCurrentView() {
  if (!state.user) return;
  saveView(state.user.id, () => ({ hash: lastRenderedHash || location.hash, scroll: app.scrollTop, state: currentCleanup?.getViewState?.() ?? null }));
}
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && saveCurrentView());
window.addEventListener("pagehide", saveCurrentView);
setInterval(() => document.visibilityState !== "hidden" && saveCurrentView(), 15000);

init();
