// The router: which screen each #/hash opens (moved out of app.js with the refactor tool, docs/architecture-roadmap.md step 6).
// renderRoute takes app.js's shared state as `ctx` (the ctx object at the top of app.js); render() in app.js calls it.
import { getLang } from "../i18n.js";
import { state } from "../state.js";
import { markShellShown } from "../launchTiming.js";
import { shellAllows } from "../opsShell.js";
import { canSeeCashflow } from "../shared/roles.js";
import { mountInstallPrompt } from "../install.js";
import { preloadArmeniaTiles, preloadCoreViews } from "./preload.js";
import { isUpdatePending } from "../updateBanner.js";
import { pruneParkedSheet, takeParkedSheet } from "../util.js";
import { startLocationBroadcast } from "../locationBroadcast.js";
import { startDriverArrival } from "../driverArrival.js";
import { flushQueue } from "../offlineQueue.js";
import { refreshAccountingBadge, refreshDeliveryBadge, refreshNotificationBadge, refreshOrderBadge, refreshPaymentBadge, refreshPlanApprovalBadge, refreshUnrecordedBadge, refreshWarehouseBadge } from "../badges.js";

export async function renderRoute(ctx) {
  // A screen whose code arrives after a newer render started (the session turned out to be expired while the remembered Home was
  // loading, a fast second tap) must not paint over the newer screen: it is dropped (render() ignores STALE_ROUTE).
  const mySeq = ctx.renderSeq;
  const fresh = (loading) => loading.then((m) => {
    if (mySeq !== ctx.renderSeq) throw ctx.STALE_ROUTE;
    return m;
  });
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
    if (ctx.currentCleanup) {
      ctx.currentCleanup();
      ctx.currentCleanup = null;
    }
    // A logged-out session's back-cache would otherwise hold onto this
    // account's DOM (and whatever cleanup it owned) across a login screen
    // that might belong to a different account entirely on a shared device.
    ctx.backStack.forEach(ctx.disposeBackEntry);
    ctx.backStack = [];
    ctx.disposeParkedMap();
    ctx.lastRenderedHash = null;
    ctx.topBar.hidden = true;
    ctx.navBar.hidden = true;
    ctx.sidebar.hidden = true;
    const { renderLogin } = await fresh(import("../views/login.js"));
    renderLogin(ctx.app, async () => {
      location.hash = "#/dashboard";
      startLocationBroadcast();
      startDriverArrival(ctx.navigate);
      // A session that expired while this device had queued offline work
      // stops flushQueue() at the first 401 rather than deleting that work
      // (see offlineQueue.js) -- nothing else re-triggers a flush once the
      // rep is back online AND re-authenticated (the 'online' listener
      // already fired before they logged back in), so a fresh login is the
      // other point that needs its own retry.
      flushQueue();
      ctx.render();
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

  ctx.topBar.hidden = false;
  ctx.navBar.hidden = false;
  ctx.sidebar.hidden = false;
  markShellShown();
  // Warehouse manager / driver: their own small app -- anything outside their screens goes back to their Home.
  if (!shellAllows(state.user.role, location.hash)) {
    location.replace("#/dashboard");
    return;
  }
  // Cashflow holds salaries and every money movement: only the owner's own roles open it (server: canSeeCashflow); anyone else who types or follows the
  // address lands on Home instead of an empty page with an error (a deep link from an old notification, a bookmark).
  if (/^#\/cashflow(\?|$)/.test(location.hash) && !canSeeCashflow(state.user.role)) {
    location.replace("#/dashboard");
    return;
  }
  ctx.renderNav();
  mountInstallPrompt(ctx.installRoot);
  preloadCoreViews();
  preloadArmeniaTiles();

  const hash = location.hash || "#/dashboard";
  // A new version is waiting and the person chose "Later": the screens already loaded are the old ones, and a screen opened for the first
  // time now would come from the new files and clash with them ("This screen could not load", e.g. the customer card). Moving to another
  // screen is the safe moment to switch: reload straight onto it.
  if (isUpdatePending() && ctx.lastRenderedHash && hash.split("?")[0] !== ctx.lastRenderedHash.split("?")[0]) {
    location.reload();
    return;
  }
  if (ctx.HOME_TREE_ROUTES.has(hash.split("?")[0])) ctx.lastHomeHash = hash;

  // Restore from the back-cache -- only on a genuine back/forward
  // navigation (see the popstate listener below), and only when it's the
  // exact screen we most recently left. Reattaches the same DOM nodes (so
  // every click listener, timer, and closure-held filter/sort/search state
  // is still exactly as it was) instead of asking the route's view module
  // to rebuild everything from scratch and lose all of it.
  const isHistory = !ctx.programmaticNav;
  ctx.programmaticNav = false;
  // Back to the Map tab while it sits parked: it is the entry to restore (a Map link with a customer, add or plan flag builds fresh).
  if (hash === "#/map" && ctx.parkedMap && !ctx.backStack.some((entry) => entry.hash === "#/map")) {
    ctx.backStack.push(ctx.parkedMap);
    ctx.parkedMap = null;
  }
  let matchIdx = -1;
  for (let i = ctx.backStack.length - 1; i >= 0; i--) {
    if (ctx.backStack[i].hash === hash) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx >= 0 && (matchIdx === ctx.backStack.length - 1 || isHistory)) {
    if (ctx.currentCleanup) {
      ctx.currentCleanup();
      ctx.currentCleanup = null;
    }
    // Screens opened after the one we are returning to are being unwound.
    ctx.backStack.splice(matchIdx + 1).forEach(ctx.disposeBackEntry);
    const { nodes, cleanup, scrollTop, appClassName, bodyClassName } = ctx.backStack.pop();
    ctx.app.replaceChildren(nodes);
    // Reapply whatever #app/document.body class customization the
    // restored view had made at mount time (e.g. map.js's scroll lock) --
    // stripped below when it was stashed, since its own cleanup function
    // (the only thing that normally removes them) is deferred, not run,
    // while a view sits in the back-cache.
    ctx.app.className = appClassName ?? ctx.baseAppClassName;
    document.body.className = bodyClassName ?? ctx.baseBodyClassName;
    ctx.currentCleanup = cleanup || null;
    ctx.lastRenderedHash = hash;
    requestAnimationFrame(() => {
      ctx.app.scrollTop = scrollTop;
    });
    // A restored view's DOM/closures are exactly as they were when the
    // user left -- including whatever data they rendered with, which may
    // no longer be current (e.g. map.js's markers after an edit made on a
    // customer detail page visited in between). A view that cares opts in
    // by attaching an onRestore() hook to its cleanup function; one that
    // doesn't need this is unaffected.
    ctx.currentCleanup?.onRestore?.();
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
  if (ctx.NAV_TAB_ROOT_HASHES.has(hash.split("?")[0]) && !isHistory) {
    const mapEntry = ctx.backStack.find((entry) => entry.hash === "#/map");
    ctx.backStack.forEach((entry) => entry !== mapEntry && ctx.disposeBackEntry(entry));
    ctx.backStack = [];
    if (mapEntry) ctx.parkMap(mapEntry);
  }
  // A Map that is about to be built fresh (a link with a flag, a restart) replaces whatever is parked.
  if (hash.startsWith("#/map")) ctx.disposeParkedMap();
  ctx.backStack = ctx.backStack.filter((entry) => {
    if (entry.hash !== hash) return true;
    ctx.disposeBackEntry(entry);
    return false;
  });
  if (isHistory && ctx.lastRenderedHash && ctx.lastRenderedHash !== hash && ctx.app.firstChild && matchIdx < 0 && ctx.backStack.length === 0) {
    // History traversal to a screen we hold no copy of, with nothing cached:
    // keep the trail as it is rather than caching the screen we leave.
    if (ctx.currentCleanup) {
      ctx.currentCleanup();
      ctx.currentCleanup = null;
    }
  } else if (ctx.lastRenderedHash && ctx.lastRenderedHash !== hash && ctx.app.firstChild && !ctx.isModalMapFlow(ctx.lastRenderedHash)) {
    // Captured BEFORE emptying #app below -- a scroll container with no
    // children always reports scrollTop 0, so reading it after the move
    // loop would silently throw away the real position every time.
    const scrollTopSnapshot = ctx.app.scrollTop;
    const appClassNameSnapshot = ctx.app.className;
    const bodyClassNameSnapshot = document.body.className;
    const fragment = document.createDocumentFragment();
    while (ctx.app.firstChild) fragment.appendChild(ctx.app.firstChild);
    ctx.backStack.push({
      hash: ctx.lastRenderedHash,
      nodes: fragment,
      cleanup: ctx.currentCleanup,
      scrollTop: scrollTopSnapshot,
      appClassName: appClassNameSnapshot,
      bodyClassName: bodyClassNameSnapshot,
    });
    ctx.currentCleanup = null; // ownership transferred to the back stack
    ctx.trimBackStack();
    // The outgoing view's cleanup function -- the only thing that would
    // normally strip any #app/document.body classes it added at mount
    // time -- isn't going to run until its entry is evicted, which may be
    // much later or never. The next view must not inherit them (e.g.
    // mounting a checkin page under map.js's scroll-locking class), so
    // reset to the true baseline now; restoring that entry later reapplies
    // its own snapshot.
    ctx.app.className = ctx.baseAppClassName;
    document.body.className = ctx.baseBodyClassName;
  } else if (ctx.currentCleanup) {
    ctx.currentCleanup();
    ctx.currentCleanup = null;
  }
  // A parked sheet only survives while the screen it was opened on is the one
  // sitting in the back-cache.
  pruneParkedSheet(ctx.backStack.map((entry) => entry.hash));
  ctx.lastRenderedHash = hash;

  const [path, queryString] = hash.split("?");
  if (path !== ctx.currentPath) {
    ctx.currentPath = path;
    requestAnimationFrame(() => ctx.app.focus({ preventScroll: true }));
  }
  const query = new URLSearchParams(queryString || "");
  const customerMatch = path.match(/^#\/customers\/(\d+)$/);
  const productMatch = path.match(/^#\/product\/(\d+)$/);
  const customerOrdersMatch = path.match(/^#\/customers\/(\d+)\/orders$/);
  const checkinSpotsMatch = path.match(/^#\/customers\/(\d+)\/spots$/);
  const specialPricesMatch = path.match(/^#\/customers\/(\d+)\/special-prices$/);
  const checkinMatch = path.match(/^#\/checkin\/(\d+)$/);
  const orderCreateMatch = path.match(/^#\/orders\/new\/(\d+)$/);
  const paymentDetailMatch = path.match(/^#\/payments\/(\d+)$/);
  const handoffDetailMatch = path.match(/^#\/cash-handoffs\/(\d+)$/);
  const routePlanSetMatch = path.match(/^#\/route-plan-sets\/(\d+)$/);

  if (path === "#/dashboard" && state.user.role === "warehouse_manager") {
    ctx.currentCleanup = await (await fresh(import("../views/warehouseHome.js"))).renderWarehouseHome(ctx.app, ctx.navigate);
  } else if (path === "#/dashboard" && state.user.role === "delivery_manager") {
    ctx.currentCleanup = await (await fresh(import("../views/driverHome.js"))).renderDriverHome(ctx.app, ctx.navigate);
  } else if (path === "#/wh-home") {
    // The same Home, opened from the normal app (admin / management compare it with the old screens).
    ctx.currentCleanup = await (await fresh(import("../views/warehouseHome.js"))).renderWarehouseHome(ctx.app, ctx.navigate);
  } else if (path === "#/driver-home") {
    ctx.currentCleanup = await (await fresh(import("../views/driverHome.js"))).renderDriverHome(ctx.app, ctx.navigate);
  } else if (path === "#/cashflow") {
    (await fresh(import("../views/cashflow.js"))).renderCashflow(ctx.app, ctx.navigate);
  } else if (path === "#/returns") {
    (await fresh(import("../views/returns.js"))).renderReturns(ctx.app, ctx.navigate);
  } else if (path === "#/staff" || /^#\/staff\/\d+$/.test(path)) {
    (await fresh(import("../views/staff.js"))).renderStaff(ctx.app, ctx.navigate, path.split("/")[2] ?? null, query);
  } else if (path === "#/wh-pack") {
    ctx.currentCleanup = await (await fresh(import("../views/warehousePack.js"))).renderWarehousePack(ctx.app, ctx.navigate, query.get("tab"));
  } else if (path === "#/dashboard") {
    (await fresh(import("../views/dashboard.js"))).renderDashboard(ctx.app, ctx.navigate);
  } else if (path === "#/activity") {
    ctx.currentCleanup = (await fresh(import("../views/activity.js"))).renderActivity(ctx.app, ctx.navigate);
  } else if (path === "#/map") {
    const { renderMap } = await fresh(import("../views/map.js"));
    ctx.currentCleanup = renderMap(
      ctx.app,
      ctx.navigate,
      query.get("relocate"),
      query.get("add") === "1",
      query.get("plan") === "1",
      query.get("customer")
    );
  } else if (path === "#/customers") {
    ctx.currentCleanup = (await fresh(import("../views/customers.js"))).renderCustomers(ctx.app, ctx.navigate, query.get("visited"), query.get("potential") ?? "");
  } else if (specialPricesMatch) {
    (await fresh(import("../views/specialPrices.js"))).renderSpecialPrices(ctx.app, ctx.navigate, specialPricesMatch[1]);
  } else if (checkinSpotsMatch) {
    (await fresh(import("../views/checkinSpots.js"))).renderCheckinSpots(ctx.app, ctx.navigate, checkinSpotsMatch[1], query);
  } else if (customerOrdersMatch) {
    (await fresh(import("../views/customerOrders.js"))).renderCustomerOrders(ctx.app, ctx.navigate, customerOrdersMatch[1]);
  } else if (orderCreateMatch) {
    (await fresh(import("../views/orderCreate.js"))).renderOrderCreate(ctx.app, ctx.navigate, orderCreateMatch[1], query.get("checkin"), { from: query.get("from"), usual: query.get("usual") === "1" });
  } else if (path === "#/orders") {
    ctx.currentCleanup = (await fresh(import("../views/orders.js"))).renderOrders(ctx.app, ctx.navigate, query.get("open"), { startNew: query.get("new") === "1" });
  } else if (paymentDetailMatch) {
    (await fresh(import("../views/payments.js"))).renderPayments(ctx.app, ctx.navigate, paymentDetailMatch[1]);
  } else if (path === "#/payments") {
    (await fresh(import("../views/payments.js"))).renderPayments(ctx.app, ctx.navigate, null, query);
  } else if (handoffDetailMatch) {
    (await fresh(import("../views/cashHandoffs.js"))).renderCashHandoffs(ctx.app, ctx.navigate, handoffDetailMatch[1]);
  } else if (path === "#/cash-handoffs") {
    (await fresh(import("../views/cashHandoffs.js"))).renderCashHandoffs(ctx.app, ctx.navigate, null, { handover: query.get("handover") === "1" });
  } else if (path === "#/money") {
    (await fresh(import("../views/money.js"))).renderMoney(ctx.app, ctx.navigate);
  } else if (path === "#/expenses") {
    (await fresh(import("../views/cashExpenses.js"))).renderCashExpenses(ctx.app, ctx.navigate);
  } else if (path === "#/reports") {
    (await fresh(import("../views/reports.js"))).renderReports(ctx.app, ctx.navigate, query.get("r"));
  } else if (path === "#/route-distribution") {
    (await fresh(import("../views/routeDistribution.js"))).renderRouteDistribution(ctx.app, ctx.navigate);
  } else if (routePlanSetMatch) {
    (await fresh(import("../views/routePlanSets.js"))).renderRoutePlanSet(ctx.app, ctx.navigate, Number(routePlanSetMatch[1]));
  } else if (path === "#/route-plans") {
    (await fresh(import("../views/routePlans.js"))).renderRoutePlans(ctx.app, ctx.navigate);
  } else if (path === "#/ops-control") {
    (await fresh(import("../views/opsControl.js"))).renderOpsControl(ctx.app, ctx.navigate, query.get("tab"));
  } else if (path === "#/ask-kad") {
    (await fresh(import("../views/askKad.js"))).renderAskKad(ctx.app, ctx.navigate);
  } else if (path === "#/vaghinak") {
    (await fresh(import("../views/vaghinak.js"))).renderVaghinak(ctx.app, ctx.navigate, query);
  } else if (path === "#/team-progress") {
    (await fresh(import("../views/repProgress.js"))).renderRepProgress(ctx.app, ctx.navigate);
  } else if (path === "#/team-performance" || /^#\/team-performance\/(planning|approvals)$/.test(path)) {
    // Notifications sent before 1.360.0 carry #/team-performance/<tab>; new ones use ?tab=<tab>.
    const legacyTab = path.split("/")[2];
    if (legacyTab) query.set("tab", legacyTab);
    (await fresh(import("../views/teamPerformance.js"))).renderTeamPerformance(ctx.app, ctx.navigate, query);
  } else if (path === "#/company-dashboard") {
    (await fresh(import("../views/dashboardOverview.js"))).renderDashboardOverview(ctx.app, ctx.navigate);
  } else if (path === "#/pricelist") {
    (await fresh(import("../views/pricelist.js"))).renderPricelist(ctx.app, ctx.navigate);
  } else if (productMatch) {
    (await fresh(import("../views/productDetail.js"))).renderProductDetail(ctx.app, ctx.navigate, productMatch[1]);
  } else if (path === "#/warehouse") {
    (await fresh(import("../views/warehouse.js"))).renderWarehouse(ctx.app, ctx.navigate);
  } else if (path === "#/delivery") {
    (await fresh(import("../views/deliveryRoute.js"))).renderDelivery(ctx.app, ctx.navigate);
  } else if (path === "#/accounting") {
    (await fresh(import("../views/accounting.js"))).renderAccounting(ctx.app, ctx.navigate);
  } else if (path === "#/documents") {
    (await fresh(import("../views/documents.js"))).renderDocuments(ctx.app, ctx.navigate);
  } else if (path === "#/recorded") {
    (await fresh(import("../views/recorded.js"))).renderRecorded(ctx.app, ctx.navigate);
  } else if (path === "#/debt-balances") {
    ctx.currentCleanup = (await fresh(import("../views/debtBalances.js"))).renderDebtBalances(ctx.app, ctx.navigate);
  } else if (path === "#/sales") {
    (await fresh(import("../views/sales.js"))).renderSales(ctx.app, ctx.navigate);
  } else if (customerMatch) {
    (await fresh(import("../views/customerDetail.js"))).renderCustomerDetail(ctx.app, ctx.navigate, customerMatch[1]);
  } else if (checkinMatch) {
    (await fresh(import("../views/checkin.js"))).renderCheckin(ctx.app, ctx.navigate, checkinMatch[1]);
  } else if (path === "#/settings") {
    (await fresh(import("../views/settings.js"))).renderSettings(ctx.app, ctx.doLogout, ctx.render, query.get("section"), ctx.navigate);
  } else if (path === "#/notifications") {
    (await fresh(import("../views/notifications.js"))).renderNotifications(ctx.app, ctx.navigate, refreshNotificationBadge);
  } else if (path === "#/tasks") {
    ctx.currentCleanup = (await fresh(import("../views/tasks.js"))).renderTasks(ctx.app, ctx.navigate, query.get("open"));
  } else if (path === "#/bonuses") {
    (await fresh(import("../views/bonuses.js"))).renderBonuses(ctx.app, ctx.navigate);
  } else {
    ctx.navigate("#/dashboard");
  }
}
