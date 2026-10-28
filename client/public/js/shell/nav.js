// The bottom tab bar, the top bar and the desktop sidebar (moved out of app.js with the refactor tool, docs/architecture-roadmap.md
// step 6). The functions that render them take app.js's shared state as `ctx` (the ctx object at the top of app.js).
import { icons } from "../icons.js";
import { getLang, t } from "../i18n.js";
import { state } from "../state.js";
import { applyDeliveryBadge, applyNotificationBadge, applyOrderBadge, applyPlanApprovalBadge, applyWarehouseBadge } from "../badges.js";
import { opsShellFor } from "../opsShell.js";
import { QUICK_ACTIONS, QUICK_ACTION_ROUTE, visibleQuickActionIds } from "../quickActions.js";
import { escapeHtml } from "../util.js";

// Icons for the sidebar's role-visible quick-action items that aren't
// already one of the 5 core routes (see EXCLUDED_FROM_SIDEBAR below).
// colorClass is the exact same quick-action-icon-* class the Home screen's
// grid uses for this same action (dashboard.js's QUICK_ACTION_ICON) -- the
// two used to diverge (plain glyph here, colored tile there) for the
// identical destination; reusing the same class instead of inventing a
// second palette keeps them looking like the same action everywhere it
// appears, not two different ones.
export const SIDEBAR_ITEM_ICON = {
  qa_plan_route: { icon: icons.planDay, colorClass: "quick-action-icon-route" },
  qa_money: { icon: icons.payment, colorClass: "quick-action-icon-payments" },
  qa_pricelist: { icon: icons.tag, colorClass: "quick-action-icon-pricelist" },
  qa_warehouse: { icon: icons.box, colorClass: "quick-action-icon-warehouse" },
  qa_cashflow: { icon: icons.wallet, colorClass: "quick-action-icon-debt" },
  qa_staff: { icon: icons.person, colorClass: "quick-action-icon-team" },
  qa_returns: { icon: icons.undo, colorClass: "quick-action-icon-debt" },
  qa_wh_home: { icon: icons.box, colorClass: "quick-action-icon-warehouse" },
  qa_driver_home: { icon: icons.truck, colorClass: "quick-action-icon-delivery" },
  qa_delivery: { icon: icons.truck, colorClass: "quick-action-icon-delivery" },
  qa_recorded: { icon: icons.clock, colorClass: "quick-action-icon-recorded" },
  qa_accounting: { icon: icons.note, colorClass: "quick-action-icon-accounting" },
  qa_documents: { icon: icons.folder, colorClass: "quick-action-icon-accounting" },
  qa_team_performance: { icon: icons.target, colorClass: "quick-action-icon-team" },
  qa_reports: { icon: icons.chart, colorClass: "quick-action-icon-reports" },
  qa_debt_balances: { icon: icons.wallet, colorClass: "quick-action-icon-debt" },
  qa_company_dashboard: { icon: icons.dashboard, colorClass: "quick-action-icon-company" },
  qa_sales: { icon: icons.trendUp, colorClass: "quick-action-icon-sales" },
  qa_tasks: { icon: icons.tasks, colorClass: "quick-action-icon-tasks" },
  qa_vaghinak: { icon: icons.vaghinak, colorClass: "quick-action-icon-vaghinak" },
  qa_ask_kad: { icon: icons.sparkles, colorClass: "quick-action-icon-askkad" },
  qa_bonuses: { icon: icons.gift, colorClass: "quick-action-icon-bonuses" },
};

// qa_check_in and qa_add_customer both jump into #/map (with a query
// param) -- they're "do a thing right now" shortcuts that make sense as
// their own tile on a phone's home screen, not a second, redundant
// destination next to the Map item the sidebar already has.
// The two "(new)" role apps are previews for management on the Home grid; in the sidebar they read as a second Warehouse
// and a stray Driver item (owner, 2026-10-27: roadmap step 5), so the sidebar leaves them out.
export const EXCLUDED_FROM_SIDEBAR = new Set(["qa_check_in", "qa_add_customer", "qa_tasks", "qa_wh_home", "qa_driver_home"]);

// The sidebar's MORE list in groups (docs/desktop-roadmap.md, step 5). A tile not named here lands in a last "More" group,
// so a new Home tile is never lost from the sidebar. A group folds; the folded groups are remembered on this device.
export const SIDEBAR_GROUPS = [
  { key: "sales", label: "sidebar_group_sales", ids: ["qa_vaghinak", "qa_team_performance", "qa_sales", "qa_reports", "qa_plan_route", "qa_bonuses"] },
  { key: "money", label: "sidebar_group_money", ids: ["qa_money", "qa_debt_balances", "qa_cashflow", "qa_accounting", "qa_recorded"] },
  { key: "operations", label: "sidebar_group_operations", ids: ["qa_delivery", "qa_warehouse", "qa_returns", "qa_documents", "qa_pricelist"] },
  { key: "admin", label: "sidebar_group_admin", ids: ["qa_staff", "qa_ask_kad", "qa_company_dashboard"] },
];

export const SIDEBAR_FOLD_KEY = "fieldvisits_sidebar_folded";

export const SIDEBAR_MODE_KEY = "fieldvisits_sidebar_mode"; // "auto" (icons only below 1280 px) | "collapsed" | "full"

export const readPref = (key, fallback) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

export const writePref = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the choice lasts until the page closes */
  }
};

// The bars are built once per language / user (and again when settings change what they list); a route change only moves the "active" mark.
// They used to be torn down and rebuilt on EVERY hash change, which flashed the active state of the tab being tapped and re-created every
// button (and its listener) in the middle of a tap.
export function syncNavActive(ctx, hash) {
  const base = hash.split("?")[0];
  const setCurrent = (el, active) => (active ? el.setAttribute("aria-current", "page") : el.removeAttribute("aria-current"));
  const mark = (selector, activeClass) =>
    document.querySelectorAll(selector).forEach((el) => {
      const active = el.dataset.hash === hash;
      el.classList.toggle(activeClass, active);
      setCurrent(el, active);
    });
  mark("#nav-bar .nav-item[data-hash]", "nav-item-active");
  mark("#nav-bar .nav-item-center[data-hash]", "nav-item-center-active");
  mark("#sidebar .sidebar-item[data-hash]", "sidebar-item-active");
  const bell = ctx.topBar.querySelector("#topbar-bell-btn");
  const menu = ctx.topBar.querySelector("#topbar-menu-btn");
  if (bell) setCurrent(bell, hash === "#/notifications");
  if (menu) setCurrent(menu, base === "#/settings");
}

export function renderNav(ctx) {
  const hash = (location.hash || "#/dashboard").split("?")[0];
  const signature = `${getLang()}|${state.user.name}|${state.user.role}`;
  if (signature !== ctx.lastNavSignature) {
    ctx.lastNavSignature = signature;
    ctx.rebuildNavMarkup(hash);
    ctx.rebuildSidebarMarkup(hash);
  }
  ctx.syncNavActive(hash);
  applyOrderBadge();
  applyNotificationBadge();
  applyPlanApprovalBadge();
  if (opsShellFor(state.user.role)) {
    applyWarehouseBadge();
    applyDeliveryBadge();
  }
}

// Icons-only sidebar: chosen by the toggle, or automatically on a 1024-1279 px window.
export function applySidebarMode(ctx) {
  const mode = readPref(SIDEBAR_MODE_KEY, "auto");
  const narrow = window.matchMedia?.("(max-width: 1279px)").matches;
  const collapsed = mode === "collapsed" || (mode === "auto" && narrow);
  document.documentElement.classList.toggle("sidebar-collapsed", collapsed);
  const toggle = document.querySelector("#sidebar-toggle");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(collapsed));
    toggle.setAttribute("aria-label", t(collapsed ? "sidebar_expand" : "sidebar_collapse"));
    toggle.title = t(collapsed ? "sidebar_expand" : "sidebar_collapse");
  }
}

export function rebuildSidebarMarkup(ctx, hash) {
  if (!ctx.sidebar) return;

  const shell = opsShellFor(state.user.role);
  const allVisibleIds = shell ? [] : visibleQuickActionIds(state.user.role, ctx.cachedSettings?.quick_action_visibility);
  const coreItems = shell
    ? ctx.shellTabs(shell)
    : [
    { hash: "#/dashboard", label: t("nav_dashboard"), icon: icons.home },
    { hash: "#/activity", label: t("nav_activity"), icon: icons.activity },
    { hash: "#/map", label: t("nav_map"), icon: icons.map },
    { hash: "#/customers", label: t("nav_customers"), icon: icons.customers },
    { hash: "#/orders", label: t("nav_orders"), icon: icons.cart, badgeId: "sidebar-orders-badge" },
    // Tasks is one of the four screens a director lives in (owner, 2026-10-18): a main item, not buried under "More"
    // (still hidden for a role whose Home grid hides it).
    ...(allVisibleIds.includes("qa_tasks") ? [{ hash: "#/tasks", label: t("qa_tasks"), icon: icons.tasks }] : []),
  ];

  const visibleIds = allVisibleIds.filter(
    (id) => !EXCLUDED_FROM_SIDEBAR.has(id) && (id !== "qa_bonuses" || ctx.cachedSettings?.bonuses_enabled)
  );
  const moreItems = QUICK_ACTIONS.filter((a) => visibleIds.includes(a.id) && QUICK_ACTION_ROUTE[a.id]).map((a) => {
    const entry = SIDEBAR_ITEM_ICON[a.id];
    return {
      id: a.id,
      hash: QUICK_ACTION_ROUTE[a.id],
      label: t(a.id),
      icon: entry?.icon || icons.chart,
      colorClass: entry?.colorClass,
    };
  });
  // MORE in groups; a group with nothing this person may open is not shown
  const grouped = new Set(SIDEBAR_GROUPS.flatMap((g) => g.ids));
  const groups = [
    ...SIDEBAR_GROUPS.map((g) => ({ key: g.key, label: t(g.label), items: g.ids.map((id) => moreItems.find((m) => m.id === id)).filter(Boolean) })),
    { key: "more", label: t("nav_more"), items: moreItems.filter((m) => !grouped.has(m.id)) },
  ].filter((g) => g.items.length);
  let folded = new Set();
  try {
    folded = new Set(JSON.parse(readPref(SIDEBAR_FOLD_KEY, "[]")));
  } catch {
    folded = new Set();
  }

  function itemHtml(item) {
    const active = hash === item.hash;
    return `
      <button type="button" class="sidebar-item ${active ? "sidebar-item-active" : ""}" data-hash="${item.hash}" ${active ? 'aria-current="page"' : ""} title="${escapeHtml(item.label)}">
        <span class="sidebar-item-icon ${item.colorClass ? `quick-action-icon ${item.colorClass}` : ""}">
          ${item.icon}
          ${item.badgeId ? `<span class="nav-badge count-badge" id="${item.badgeId}" hidden></span>` : ""}
          ${item.badge ? `<span class="nav-badge count-badge" data-shell-badge="${item.badge}" hidden></span>` : ""}
        </span>
        <span>${item.label}</span>
      </button>
    `;
  }

  ctx.sidebar.innerHTML = `
    <div class="sidebar-brand">
      <img class="topbar-logo topbar-logo-wordmark" src="/brand/kad-wordmark.png" alt="KAD" />
      <span class="topbar-title">${t("app_name_suffix")}</span>
    </div>
    <nav class="sidebar-nav" aria-label="${t("nav_settings")}">
      ${coreItems.map(itemHtml).join("")}
      ${groups
        .map((g) => {
          // a folded group hides its items except the page that is open now (desktop.css), so moving between pages needs no rebuild
          const open = !folded.has(g.key);
          return `<div class="sidebar-group${open ? "" : " is-folded"}" data-group="${g.key}">
            <button type="button" class="sidebar-section-label sidebar-group-head" data-group-toggle="${g.key}" aria-expanded="${open}">
              <span>${escapeHtml(g.label)}</span><span class="sidebar-group-chevron" aria-hidden="true"></span>
            </button>
            ${g.items.map(itemHtml).join("")}
          </div>`;
        })
        .join("")}
    </nav>
  `;
  // the icons-only toggle sits in the logo row, always in reach (a role shell has none: its sidebar is short)
  if (!shell) {
    ctx.sidebar
      .querySelector(".sidebar-brand")
      ?.insertAdjacentHTML("beforeend", `<button type="button" class="sidebar-toggle" id="sidebar-toggle" aria-pressed="false">${icons.chevronLeft}</button>`);
  }
  ctx.sidebar.querySelectorAll("[data-hash]").forEach((el) => {
    el.addEventListener("click", () => ctx.handleNavTap(el.dataset.hash === "#/dashboard" ? ctx.homeNavTarget() : el.dataset.hash));
  });
  ctx.sidebar.querySelectorAll("[data-group-toggle]").forEach((el) =>
    el.addEventListener("click", () => {
      const key = el.dataset.groupToggle;
      if (folded.has(key)) folded.delete(key);
      else folded.add(key);
      writePref(SIDEBAR_FOLD_KEY, JSON.stringify([...folded]));
      el.setAttribute("aria-expanded", String(!folded.has(key)));
      el.closest(".sidebar-group")?.classList.toggle("is-folded", folded.has(key));
    })
  );
  // The toggle flips between icons only and full width; the choice is remembered (auto again only after storage is cleared).
  ctx.sidebar.querySelector("#sidebar-toggle")?.addEventListener("click", () => {
    const collapsed = document.documentElement.classList.contains("sidebar-collapsed");
    writePref(SIDEBAR_MODE_KEY, collapsed ? "full" : "collapsed");
    ctx.applySidebarMode();
  });
  // A role shell (warehouse / driver) has no toggle: its sidebar is always full.
  if (shell) document.documentElement.classList.remove("sidebar-collapsed");
  else ctx.applySidebarMode();
}

// The bottom tabs of a role shell (warehouse manager / driver): their own screens, no centre map button.
export function shellTabs(ctx, shell) {
  return shell.tabs.map((tab) => ({ hash: tab.hash, label: t(tab.label), icon: icons[tab.icon], badge: tab.badge }));
}

export function rebuildNavMarkup(ctx, hash) {
  const shell = opsShellFor(state.user.role);
  const items = shell
    ? ctx.shellTabs(shell)
    : [
        { hash: "#/dashboard", label: t("nav_dashboard"), icon: icons.home },
        { hash: "#/activity", label: t("nav_activity"), icon: icons.activity },
        { hash: "#/map", label: t("nav_map"), icon: icons.map, center: true },
        { hash: "#/customers", label: t("nav_customers"), icon: icons.customers },
        { hash: "#/orders", label: t("nav_orders"), icon: icons.cart },
      ];

  ctx.navBar.innerHTML = items
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
          ${item.badge ? `<span class="nav-badge count-badge" data-shell-badge="${item.badge}" hidden></span>` : ""}
        </span>
        <span>${item.label}</span>
      </button>
    `
    )
    .join("");

  ctx.navBar.querySelectorAll("[data-hash]").forEach((el) => {
    el.addEventListener("click", () => ctx.handleNavTap(el.dataset.hash === "#/dashboard" ? ctx.homeNavTarget() : el.dataset.hash));
  });

  ctx.topBar.innerHTML = `
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
      <button type="button" class="topbar-menu-btn" id="topbar-menu-btn" aria-label="${t("nav_settings")}" ${hash.split("?")[0] === "#/settings" ? 'aria-current="page"' : ""}>
        ${icons.menu}
        <span class="nav-badge count-badge" id="topbar-menu-badge" hidden></span>
      </button>
    </div>
  `;
  // Desktop: global search + quick actions + keyboard shortcuts (deskTopBar.js; fetched only on a desktop-wide window).
  if (window.matchMedia?.("(min-width: 1024px)").matches) {
    const allowed = !opsShellFor(state.user.role);
    import("../deskTopBar.js").then((m) => m.installDeskTopBar(ctx.topBar, ctx.navigate, { allowed })).catch(() => {});
  }
  ctx.topBar.querySelector("#topbar-bell-btn").addEventListener("click", () => ctx.navigate("#/notifications"));
  ctx.topBar.querySelector("#topbar-menu-btn").addEventListener("click", () => {
    const current = (location.hash || "#/dashboard").split("?")[0];
    if (current === "#/settings") {
      ctx.navigate(ctx.preSettingsHash);
    } else {
      ctx.preSettingsHash = current;
      ctx.navigate("#/settings");
    }
  });
}
