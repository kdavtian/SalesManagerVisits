// What "one search for everything" looks in (owner, 2026-11-04), shared by the phone's search sheet (searchPalette.js) and the desktop
// top-bar search (deskTopBar.js): the screens and actions of this person (screenCatalog.js, ranked with the shared KAD kit in both scripts,
// "kastrol" = "կաստրոլ") and the records the server lets this person see (customers, orders, open tasks; the server checks every one).
import { api } from "./api.js";
import { rankItems, recentList } from "./kit/palette.js";
import { soundKey, matchKind, prepareSearchText } from "./shared/searchKey.js";
import { actionItems, screenItems } from "./screenCatalog.js";
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

/** Records for `query` (2+ letters): { customers, orders, tasks }; a group this person's app does not have stays empty. */
export async function recordResults(query) {
  const shell = opsShellFor(state.user?.role);
  const [customers, orders, tasks] = await Promise.all([
    shell ? [] : api.listCustomers({ search: query, limit: MAX_PER_GROUP }).catch(() => []),
    api.listOrders({ q: query, limit: MAX_PER_GROUP }, { fresh: true }).then((r) => r.rows ?? []).catch(() => []),
    searchTasks(query).catch(() => []),
  ]);
  return { customers: (customers || []).slice(0, MAX_PER_GROUP), orders: orders.slice(0, MAX_PER_GROUP), tasks: tasks.slice(0, MAX_PER_GROUP) };
}
