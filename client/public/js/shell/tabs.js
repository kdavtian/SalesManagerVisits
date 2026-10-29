// Each tab keeps its pages (owner, 2026-10-29: "app don't keep pages when navigating 2-3 pages"). Customers -> a customer card -> the
// Orders tab -> back to Customers used to show a fresh, empty Customers list: a tab switch threw the left tab's pages away. Now, like
// the tab bar of an iPhone app, a tab is left with its pages parked and comes back exactly as it was (the card on screen, Back returns
// to the list with its search, filters and scroll). Tapping the tab you are on works as before (top of the screen; a quick second tap
// starts it fresh). The Map keeps its own parking (app.js parkMap), so it is not a trail here.
//
// A trail is the tab's back-cache entries (the same entries shell/routes.js keeps for Back) plus the screen on display when the tab was
// left. At most TRAILS_MAX other tabs are kept (the oldest is let go: its screens' cleanups run), so a 3 GB phone holds a bounded amount.
const TRAILS_MAX = 3;
const MAP = "#/map";
const trails = new Map(); // tab -> [entry, ...], the last one the screen to show
let currentTab = null;

// The tab the screen at `hash` belongs to when nothing else says so (the first screen after start, a link from a notification).
export function noteScreen(ctx, hash) {
  if (currentTab) return;
  const base = (hash || "#/dashboard").split("?")[0];
  if (ctx.NAV_TAB_ROOT_HASHES.has(base)) currentTab = base;
  else if (ctx.HOME_TREE_ROUTES.has(base)) currentTab = "#/dashboard";
}

// The screen on display, taken off #app as a back-cache entry (the same shape shell/routes.js stashes), or null when there is none.
function takeScreen(ctx) {
  if (!ctx.lastRenderedHash || !ctx.app.firstChild) return null;
  const entry = {
    hash: ctx.lastRenderedHash,
    scrollTop: ctx.app.scrollTop, // before emptying #app: an empty scroll container reports 0
    appClassName: ctx.app.className,
    bodyClassName: document.body.className,
    cleanup: ctx.currentCleanup,
    nodes: document.createDocumentFragment(),
  };
  while (ctx.app.firstChild) entry.nodes.appendChild(ctx.app.firstChild);
  ctx.currentCleanup = null; // owned by the trail now
  ctx.app.className = ctx.baseAppClassName;
  document.body.className = ctx.baseBodyClassName;
  return entry;
}

function showScreen(ctx, entry) {
  ctx.app.replaceChildren(entry.nodes);
  ctx.app.className = entry.appClassName ?? ctx.baseAppClassName;
  document.body.className = entry.bodyClassName ?? ctx.baseBodyClassName;
  ctx.currentCleanup = entry.cleanup || null;
  ctx.lastRenderedHash = entry.hash;
  requestAnimationFrame(() => {
    ctx.app.scrollTop = entry.scrollTop;
  });
  // a kept screen may show data that changed meanwhile: a screen that cares refreshes itself (the same hook Back uses)
  ctx.currentCleanup?.onRestore?.();
}

function dispose(ctx, trail) {
  trail.forEach((entry) => ctx.disposeBackEntry(entry));
}

// Park the tab being left. Its pages: the back-cache (pages behind the one on screen) and the screen on display.
function parkCurrent(ctx) {
  if (!currentTab || currentTab === MAP) return;
  const shown = takeScreen(ctx);
  const trail = [...ctx.backStack.filter((entry) => !entry.hash.startsWith(MAP)), ...(shown ? [shown] : [])];
  // a Map page inside the trail stays with the Map's own parking (app.js trimBackStack keeps one Map copy)
  ctx.backStack = ctx.backStack.filter((entry) => entry.hash.startsWith(MAP));
  if (!trail.length) return;
  if (trails.has(currentTab)) dispose(ctx, trails.get(currentTab));
  trails.delete(currentTab);
  trails.set(currentTab, trail);
  while (trails.size > TRAILS_MAX) {
    const [oldest, old] = trails.entries().next().value;
    trails.delete(oldest);
    dispose(ctx, old);
  }
}

// A tap on another tab. Returns true when it was handled here (the tab's pages came back); false: the caller navigates as usual (the
// tab opens fresh, as before), after the tab being left was parked.
export function switchTab(ctx, tab) {
  if (!tab || tab === currentTab) return false;
  // leaving the Map: its own parking happens in the router, as before
  if (currentTab !== MAP) parkCurrent(ctx);
  currentTab = tab;
  const trail = tab === MAP ? null : trails.get(tab);
  if (!trail) return false;
  trails.delete(tab);
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
