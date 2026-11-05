// What "one search for everything" looks in (owner, 2026-11-04), shared by the phone's search sheet (searchPalette.js) and the desktop
// top-bar search (deskTopBar.js): the screens and actions of this person (screenCatalog.js, ranked with the shared KAD kit in both scripts,
// "kastrol" = "կաստրոլ") and the records the server lets this person see (customers, orders, open tasks; the server checks every one).
import { api } from "./api.js";
import { rankItems, recentList } from "./kit/palette.js";
import { soundKey, matchKind, prepareSearchText } from "./shared/searchKey.js";
import { actionItems, screenItems } from "./screenCatalog.js";
import { searchProducts } from "./productSearch.js";
import { pinnedItems } from "./pins.js";
import { opsShellFor } from "./opsShell.js";
import { state } from "./state.js";
import { t } from "./i18n.js";

export const MAX_PER_GROUP = 5;
export const recent = recentList("fv_search_recent", { max: 6 });

/** Screens and actions for `query`, best first (no network). */
export function localResults(query, settings, limit = 6) {
  const home = { kind: "screen", id: "tab_home", hash: "#/dashboard", label: t("nav_dashboard") };
  const items = [home, ...screenItems(settings), ...actionItems()].map((it) => ({ ...it, keywords: [it.hash?.replace(/^#\//, "").replace(/[-/?=]/g, " ")] }));
  return rankItems(query, items, { normalize: soundKey, limit });
}

let tasksCache = { at: 0, rows: null };
// Open tasks are loaded once a minute at most and searched here (the task list already carries everything visible to this person).
async function searchTasks(query) {
  if (!tasksCache.rows || Date.now() - tasksCache.at > 60000) {
    const result = await api.listTasks({ scope: "all", status: "open" });
    tasksCache = { at: Date.now(), rows: result.rows ?? [] };
  }
  return tasksCache.rows
    .map((r) => ({ r, kind: matchKind(prepareSearchText([r.title, r.customer_name, r.assignee_name].filter(Boolean).join(" ")), query) }))
    .filter((x) => x.kind > 0)
    .sort((a, b) => b.kind - a.kind)
    .map((x) => x.r);
}

// Before anything is typed the search offers what is most likely wanted (owner, 2026-11-05: "improve search"): the quick actions, then
// the person's pinned screens, then the main screens, so an empty box is a menu and not a blank page.
export function suggestions(settings, { screens = 6, actions = 4 } = {}) {
  const pins = pinnedItems(settings).map((p) => ({ ...p, kind: "screen" }));
  const seen = new Set(pins.map((p) => p.id));
  const rest = screenItems(settings).filter((s) => !seen.has(s.id));
  return { actions: actionItems().slice(0, actions), screens: [...pins, ...rest].slice(0, screens) };
}

let productsCache = { at: 0, rows: null };
// Products are loaded once five minutes at most (the catalogue the order screens already use) and searched here, by name, size, brand, SKU, HC code.
async function searchCatalog(query) {
  if (!productsCache.rows || Date.now() - productsCache.at > 300000) {
    productsCache = { at: Date.now(), rows: (await api.listProducts()) ?? [] };
  }
  return searchProducts(productsCache.rows, query);
}

/** Records for `query` (2+ letters): { customers, orders, tasks, products }; a group this person's app does not have stays empty. */
export async function recordResults(query) {
  const shell = opsShellFor(state.user?.role);
  const [customers, orders, tasks, products] = await Promise.all([
    shell ? [] : api.listCustomers({ search: query, limit: MAX_PER_GROUP }).catch(() => []),
    api.listOrders({ q: query, limit: MAX_PER_GROUP }, { fresh: true }).then((r) => r.rows ?? []).catch(() => []),
    searchTasks(query).catch(() => []),
    searchCatalog(query).catch(() => []),
  ]);
  return { customers: (customers || []).slice(0, MAX_PER_GROUP), orders: orders.slice(0, MAX_PER_GROUP), tasks: tasks.slice(0, MAX_PER_GROUP), products: products.slice(0, MAX_PER_GROUP) };
}
