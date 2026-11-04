// Every screen and quick action this person may open, described once for the "More" sheet, the search (searchPalette.js), the pinned
// row on Home and the desktop sidebar's pinned group (owner, 2026-11-04: "one KAD navigation model"). The lists are the ones the app
// already uses: the bottom tabs, the Home tiles this role sees (the admin's tile visibility), the sidebar-only Bank & cash desks, grouped
// like the desktop sidebar (shell/nav.js SIDEBAR_GROUPS). The warehouse manager and the driver keep their own small app: only the screens
// it allows.
import { icons } from "./icons.js";
import { t } from "./i18n.js";
import { state, canCreateTasks } from "./state.js";
import { QUICK_ACTIONS, QUICK_ACTION_ROUTE, visibleQuickActionIds } from "./quickActions.js";
import { SIDEBAR_GROUPS, SIDEBAR_ITEM_ICON, SIDEBAR_ONLY_ITEMS } from "./shell/nav.js";
import { opsShellFor, shellAllows } from "./opsShell.js";
import { TAB_SCREENS, pinnableScreenIds } from "./shared/screens.js";

const TAB_ICON = { tab_activity: icons.activity, tab_map: icons.map, tab_customers: icons.customers, tab_orders: icons.cart };
// Home tiles that START something on the map, not a screen: offered as actions (search), not as screens of the More sheet.
const ACTION_TILES = new Set(["qa_check_in", "qa_add_customer"]);

function tileItem(id) {
  const entry = SIDEBAR_ITEM_ICON[id];
  return { kind: "screen", id, hash: QUICK_ACTION_ROUTE[id], label: t(id), icon: entry?.icon || icons.chart, colorClass: entry?.colorClass || "" };
}

/** Screens of this role (not Home): [{ kind: "screen", id, hash, label, icon, colorClass, group }] in the app's order. */
export function screenItems(settings) {
  const role = state.user?.role;
  if (!role) return [];
  const shell = opsShellFor(role);
  const visibility = settings?.quick_action_visibility ?? null;
  const tiles = visibleQuickActionIds(role, visibility).filter((id) => (id !== "qa_bonuses" || settings?.bonuses_enabled) && QUICK_ACTION_ROUTE[id] && !ACTION_TILES.has(id));
  if (shell) {
    const tabHashes = new Set(shell.tabs.map((tab) => tab.hash));
    return tiles.filter((id) => shellAllows(role, QUICK_ACTION_ROUTE[id]) && !tabHashes.has(QUICK_ACTION_ROUTE[id])).map((id) => ({ ...tileItem(id), group: "more" }));
  }
  const groupOf = new Map(SIDEBAR_GROUPS.flatMap((g) => g.ids.map((id) => [id, g.key])));
  const tabs = TAB_SCREENS.map((s) => ({ kind: "screen", id: s.id, hash: s.hash, label: t(s.label), icon: TAB_ICON[s.id], colorClass: "", group: "tabs" }));
  const extra = SIDEBAR_ONLY_ITEMS.filter((x) => x.allowed(role)).map((x) => ({ kind: "screen", id: x.id, hash: x.hash, label: t(x.id), icon: x.icon, colorClass: x.colorClass, group: groupOf.get(x.id) || "more" }));
  const order = new Map(QUICK_ACTIONS.map((a, i) => [a.id, i]));
  const tileItems = tiles.sort((a, b) => order.get(a) - order.get(b)).map((id) => ({ ...tileItem(id), group: groupOf.get(id) || "more" }));
  return [...tabs, ...tileItems, ...extra];
}

/** The ids this person may pin (the same rule the server checks). */
export function pinnableIds(settings) {
  return pinnableScreenIds(state.user?.role, settings?.quick_action_visibility ?? null, { bonusesEnabled: Boolean(settings?.bonuses_enabled) });
}

/** "Do something now" entries of the search: [{ kind: "action", id, label, icon, run(navigate) }] */
export function actionItems() {
  const role = state.user?.role;
  if (!role || opsShellFor(role)) return [];
  return [
    { kind: "action", id: "act_new_order", label: t("new_order"), icon: icons.cart, run: (navigate) => navigate("#/orders?new=1") },
    canCreateTasks()
      ? {
          kind: "action",
          id: "act_new_task",
          label: t("task_new"),
          icon: icons.tasks,
          run: () => import("./views/tasks.js").then((m) => m.openTaskEditor({ onSaved: () => window.dispatchEvent(new Event("tasks-changed")) })),
        }
      : null,
    { kind: "action", id: "act_new_customer", label: t("add_customer"), icon: icons.mapPinPlus, run: (navigate) => navigate("#/map?add=1") },
    { kind: "action", id: "act_check_in", label: t("qa_check_in"), icon: icons.mapPinCheck, run: (navigate) => navigate(QUICK_ACTION_ROUTE.qa_check_in) },
  ].filter(Boolean);
}

export const GROUP_LABEL = {
  tabs: "more_group_main",
  sales: "sidebar_group_sales",
  money: "sidebar_group_money",
  operations: "sidebar_group_operations",
  admin: "sidebar_group_admin",
  more: "nav_more",
};
// a function, not a constant: shell/nav.js and this file import each other, so SIDEBAR_GROUPS is read only when the sheet is drawn
export const groupOrder = () => ["tabs", ...SIDEBAR_GROUPS.map((g) => g.key), "more"];
