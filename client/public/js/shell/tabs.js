// Each tab keeps its pages (owner, 2026-10-29: "app don't keep pages when navigating 2-3 pages"). Customers -> a customer card -> the
// Orders tab -> back to Customers used to show a fresh, empty Customers list: a tab switch threw the left tab's pages away. Now, like
// the tab bar of an iPhone app, a tab is left with its pages parked and comes back exactly as it was (the card on screen, Back returns
// to the list with its search, filters and scroll). Tapping the tab you are on works as before (top of the screen; a quick second tap
// starts it fresh). The Map keeps its own parking (app.js parkMap), so it is not a trail here.
//
// A trail is the tab's back-cache entries (the same entries shell/routes.js keeps for Back) plus the screen on display when the tab was
// left. At most TRAILS_MAX other tabs are kept (the oldest is let go: its screens' cleanups run), so a 3 GB phone holds a bounded amount.
// iPhone keeps every tab (owner, 2026-10-30: "all tabs"); other devices the 5 most recent.
import { swapScreen } from "../screenMotion.js";
import { screenReady } from "../kit/navTiming.js";
const TRAILS_MAX = 5;
const MAP = "#/map";
const trails = new Map(); // tab -> [entry, ...], the last one the screen to show
let currentTab = null;

// The tab the screen at `hash` belongs to. A tab's own screens (its first one, one under it like #/customers/12) or a Home screen always
// say which tab is on -- they can be reached without a tab tap too: a link, an address, Back. Any other screen keeps the tab it was
// opened from.
export function noteScreen(ctx, hash) {
  const base = (hash || "#/dashboard").split("?")[0];
  const root = [...ctx.NAV_TAB_ROOT_HASHES].find((r) => base === r || base.startsWith(`${r}/`));
  if (root) currentTab = root;
  else if (ctx.HOME_TREE_ROUTES.has(base)) currentTab = "#/dashboard";
}

// The screen on display, taken off #app as a back-cache entry (the same shape shell/routes.js stashes), or null when there is none.
// With `defer`, the screen's nodes stay on display until flushTaken() (called inside the screen swap, so the fade goes from the old screen
// to the kept one and never through an empty frame); the router's state is moved at once either way.
let taken = [];
function takeScreen(ctx, { defer = false } = {}) {
  if (!ctx.lastRenderedHash || !ctx.app.firstChild) return null;
  const entry = {
    hash: ctx.lastRenderedHash,
    scrollTop: ctx.app.scrollTop, // before emptying #app: an empty scroll container reports 0
    appClassName: ctx.app.className,
    bodyClassName: document.body.className,
    cleanup: ctx.currentCleanup,
    nodes: document.createDocumentFragment(),
  };
  ctx.currentCleanup = null; // owned by the trail now
  taken.push({ entry, ctx });
  if (!defer) flushTaken();
  return entry;
}
function flushTaken() {
  const list = taken;
  taken = [];
  for (const { entry, ctx } of list) {
    while (ctx.app.firstChild) entry.nodes.appendChild(ctx.app.firstChild);
    ctx.app.className = ctx.baseAppClassName;
    document.body.className = ctx.baseBodyClassName;
  }
}

function showScreen(ctx, entry) {
  ctx.currentCleanup = entry.cleanup || null;
  ctx.lastRenderedHash = entry.hash;
  // The DOM change itself fades from the old screen to the kept one (screenMotion.js, View Transitions); with a transition it runs a
  // frame later, so only DOM work is inside, the router's state above is set at once.
  let done = false;
  const apply = () => {
    if (done) return;
    done = true;
    pendingShow = null;
    flushTaken();
    ctx.app.replaceChildren(entry.nodes);
    ctx.app.className = entry.appClassName ?? ctx.baseAppClassName;
    document.body.className = entry.bodyClassName ?? ctx.baseBodyClassName;
    ctx.app.scrollTop = entry.scrollTop;
    requestAnimationFrame(() => {
      ctx.app.scrollTop = entry.scrollTop;
    });
    // a kept screen may show data that changed meanwhile: a screen that cares refreshes itself (the same hook Back uses)
    entry.cleanup?.onRestore?.();
    screenReady(entry.hash);
  };
  pendingShow = apply;
  swapScreen(apply);
}

// A swap still waiting for its frame (a second tap within ~16 ms, the router starting): done now, so nobody sees half of it.
let pendingShow = null;
export function settleTabSwap() {
  pendingShow?.();
}

function dispose(ctx, trail) {
  trail.forEach((entry) => ctx.disposeBackEntry(entry));
}

// Park the tab being left. Its pages: the back-cache (pages behind the one on screen) and the screen on display.
function parkCurrent(ctx, { defer = false } = {}) {
  if (!currentTab || currentTab === MAP) return;
  const shown = takeScreen(ctx, { defer });
  const trail = [...ctx.backStack.filter((entry) => !entry.hash.startsWith(MAP)), ...(shown ? [shown] : [])];
  // a Map page inside the trail stays with the Map's own parking (app.js trimBackStack keeps one Map copy)
  ctx.backStack = ctx.backStack.filter((entry) => entry.hash.startsWith(MAP));
  if (!trail.length) return;
  if (trails.has(currentTab)) dispose(ctx, trails.get(currentTab));
  trails.delete(currentTab);
  trails.set(currentTab, trail);
  while (trails.size > (ctx.IS_IOS ? Infinity : TRAILS_MAX)) {
    const [oldest, old] = trails.entries().next().value;
    trails.delete(oldest);
    dispose(ctx, old);
  }
}

// A tap on another tab. Returns true when it was handled here (the tab's pages came back); false: the caller navigates as usual (the
// tab opens fresh, as before), after the tab being left was parked.
export function switchTab(ctx, tab) {
  settleTabSwap();
  if (!tab || tab === currentTab) return false;
  // leaving the Map: its own parking happens in the router, as before
  const leavingMap = currentTab === MAP;
  const trail = tab === MAP ? null : trails.get(tab);
  // the screen being left stays on display until the kept one replaces it (no empty frame), when there is a kept one
  if (!leavingMap) parkCurrent(ctx, { defer: Boolean(trail) });
  currentTab = tab;
  if (!trail) return false;
  trails.delete(tab);
  // the router does not run when a tab's pages come back: the Map on screen is parked here the same way it parks it (app.js parkMap)
  if (leavingMap && ctx.lastRenderedHash?.startsWith(MAP)) {
    const map = takeScreen(ctx, { defer: true });
    if (map) ctx.parkMap(map);
  }
  const shown = trail.pop();
  // whatever the router holds for the tab left behind is parked above; the restored tab's pages become the back-cache
  ctx.backStack.forEach((entry) => !entry.hash.startsWith(MAP) && ctx.disposeBackEntry(entry));
  ctx.backStack = [...ctx.backStack.filter((entry) => entry.hash.startsWith(MAP)), ...trail];
  ctx.currentCleanup?.();
  ctx.currentCleanup = null;
  showScreen(ctx, shown);
  // The browser history follows the tab's pages, so the phone's Back button (and an edge swipe) walks back through them: the first
  // page replaces the current entry, each next one is pushed (pushState does not fire hashchange: nothing re-renders).
  const hashes = [...trail.map((entry) => entry.hash), shown.hash];
  history.replaceState(null, "", hashes[0]);
  for (const hash of hashes.slice(1)) history.pushState(null, "", hash);
  ctx.currentPath = shown.hash.split("?")[0];
  ctx.renderNav(); // the active tab, the top bar of the restored screen
  return true;
}

// Logging out, a role or preference change: every kept page goes (their cleanups run).
export function dropTabTrails(ctx) {
  for (const trail of trails.values()) dispose(ctx, trail);
  trails.clear();
  currentTab = null;
}

export const keptTabs = () => [...trails.keys()]; // for the tests
