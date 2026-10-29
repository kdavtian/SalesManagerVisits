// The Home screen's "Quick actions" grid, described once as data so that
// three things can't drift apart: which tiles the dashboard renders, which
// tiles the admin config screen offers, and what "the current default" means
// when an admin opens that screen for the first time.
//
// Each id is BOTH the i18n key for the tile's label (t("qa_check_in")) and,
// with underscores swapped for hyphens, the tile's DOM id (#qa-check-in) --
// so there is exactly one string per action, no lookup table of aliases.

export const ALL_ROLES = [
  "sales_manager",
  "sales_director",
  "warehouse_manager",
  "delivery_manager",
  "accountant",
  "ceo",
  "operations_director",
  "admin",
];

// defaultRoles is the role set each tile shipped with (previously an inline
// ternary per tile in dashboard.js). It stays the fallback forever: a role
// with no admin-saved override renders exactly what it rendered before this
// feature existed.
// The ORDER of this array is the order of the tiles on the Home screen, in
// the desktop sidebar and in the admin tile editor.
export const QUICK_ACTIONS = [
  { id: "qa_check_in", defaultRoles: ALL_ROLES },
  // Task management: everyone receives tasks; management creates them.
  { id: "qa_tasks", defaultRoles: ALL_ROLES },
  // Vaghinak, the AI operations deputy director: his messages, questions and (for management) the team pulse.
  { id: "qa_vaghinak", defaultRoles: ALL_ROLES },
  // Ask KAD: the admin asks questions about the company's own data and an AI answers (server/src/askKad).
  { id: "qa_ask_kad", defaultRoles: ["admin"] },
  { id: "qa_add_customer", defaultRoles: ALL_ROLES },
  // Payments + Cash expense are ONE tile now (owner, 2026-10-26): it opens a page with the two buttons (views/money.js).
  { id: "qa_money", defaultRoles: ALL_ROLES },
  // Visible to every role by default -- further gated at render time on
  // app_settings.bonuses_enabled (off by default), since the tile itself
  // carries no role restriction of its own (see dashboard.js/app.js).
  { id: "qa_bonuses", defaultRoles: ALL_ROLES },
  {
    id: "qa_debt_balances",
    defaultRoles: ["admin", "ceo", "operations_director", "sales_director", "accountant", "sales_manager"],
  },
  { id: "qa_company_dashboard", defaultRoles: ["admin", "ceo", "operations_director", "sales_director", "accountant"] },
  {
    id: "qa_team_performance",
    defaultRoles: ["admin", "ceo", "operations_director", "sales_director", "accountant", "sales_manager"],
  },
  { id: "qa_reports", defaultRoles: ALL_ROLES },
  { id: "qa_delivery", defaultRoles: ["delivery_manager", "admin"] },
  // The new warehouse-manager and driver apps (owner, 2026-10-23), opened from the normal app so management can compare them with the old screens.
  { id: "qa_wh_home", defaultRoles: ["admin", "ceo", "operations_director", "sales_director"] },
  { id: "qa_driver_home", defaultRoles: ["admin", "ceo", "operations_director", "sales_director"] },
  // Sales Director and CEO/Operations Director included alongside
  // Warehouse Manager/admin -- the warehouse manager role isn't currently
  // using the app, so the director covers the same ground for now, and
  // CEO/Operations Director get the same broad operational visibility
  // they already have everywhere else. Accountant included too --
  // inventory is financial data, same access line seesFinancialExports
  // already draws elsewhere (see canManageWarehouse in server/src/shared/roles.js,
  // which this list must stay in sync with).
  // Stock count (Գույքագրում, server/src/orders/stockCount.js): the warehouse manager counts from his own Home; management and the
  // accountant follow the month here (canViewStockCount).
  { id: "qa_stock_count", defaultRoles: ["admin", "ceo", "operations_director", "accountant"] },
  {
    id: "qa_warehouse",
    defaultRoles: ["warehouse_manager", "sales_director", "ceo", "operations_director", "accountant", "admin"],
  },
  // Waybills / invoices from accounting. Everyone: a rep sees only their own
  // orders (server-side), the warehouse needs the document before it hands
  // the goods to delivery.
  { id: "qa_accounting", defaultRoles: ALL_ROLES },
  // The documents inbox (signed order blanks, signed acts, payment slips): the roles that see every customer's files (seesAllCustomerFiles).
  { id: "qa_documents", defaultRoles: ["admin", "ceo", "operations_director", "sales_director", "accountant"] },
  { id: "qa_pricelist", defaultRoles: ALL_ROLES },
  // Same visibility as the financial exports/Company Dashboard -- raw
  // per-order ERP revenue is the same sensitivity class (see
  // seesFinancialExports in server/src/shared/roles.js, which server/src/routes/
  // sales.js gates on too). A sales_manager already has their own
  // customers' order history via the customer detail page.
  { id: "qa_sales", defaultRoles: ["admin", "ceo", "operations_director", "sales_director", "accountant"] },
  { id: "qa_recorded", defaultRoles: ["admin", "ceo", "operations_director", "accountant"] },
  // Every money movement of the company (the Excel Cashflow sheet); salaries are in it, so the owner's own roles only (server: canSeeCashflow).
  { id: "qa_cashflow", defaultRoles: ["admin", "ceo", "operations_director", "accountant"] },
  // Staff: people, structure, payroll. Everybody opens it to see their own pay; a boss sees the team, the CEO / accountant everyone (server: routes/staff.js).
  { id: "qa_staff", defaultRoles: ALL_ROLES },
  // Order returns / cancellations: the rep sees their own, management and the accountant decide, the warehouse manager receives (server: routes/returns.js).
  { id: "qa_returns", defaultRoles: ["admin", "ceo", "operations_director", "sales_director", "accountant", "sales_manager"] },
  // Not in the owner's list of 15, kept (not removed) and placed last.
  { id: "qa_plan_route", defaultRoles: ALL_ROLES },
];

// Which route each tile jumps to -- shared between the Home screen's
// quick-actions grid (dashboard.js) and the desktop sidebar (app.js), so
// the two never drift apart on where a given action id actually goes.
export const QUICK_ACTION_ROUTE = {
  qa_check_in: "#/map",
  qa_plan_route: "#/route-plans",
  qa_add_customer: "#/map?add=1",
  qa_money: "#/money",
  qa_pricelist: "#/pricelist",
  qa_warehouse: "#/warehouse",
  qa_stock_count: "#/stock-count",
  qa_accounting: "#/accounting",
  qa_documents: "#/documents",
  qa_delivery: "#/delivery",
  qa_wh_home: "#/wh-home",
  qa_driver_home: "#/driver-home",
  qa_recorded: "#/recorded",
  qa_cashflow: "#/cashflow",
  qa_staff: "#/staff",
  qa_returns: "#/returns",
  qa_team_performance: "#/team-performance",
  qa_reports: "#/reports",
  qa_debt_balances: "#/debt-balances",
  qa_company_dashboard: "#/company-dashboard",
  qa_sales: "#/sales",
  qa_tasks: "#/tasks",
  qa_vaghinak: "#/vaghinak",
  qa_ask_kad: "#/ask-kad",
  qa_bonuses: "#/bonuses",
};

export const QUICK_ACTION_IDS = QUICK_ACTIONS.map((a) => a.id);

export function defaultQuickActionIds(role) {
  return QUICK_ACTIONS.filter((a) => a.defaultRoles.includes(role)).map((a) => a.id);
}

// `visibility` is app_settings.quick_action_visibility as returned by
// GET /api/settings: null when no admin ever touched it, otherwise an object
// keyed by role. A role absent from that object is *not* "show nothing" --
// it means the admin never customized that role, so it keeps its defaults.
// An explicitly-saved empty array does mean "no tiles", which is why the
// check is on key presence, not on truthiness of the array.
// A role whose saved list still names one of the two tiles that became "Payments & expenses" keeps that tile.
export const MERGED_INTO_MONEY = ["qa_payments", "qa_cash_expense"];
export function withMergedTiles(ids) {
  return ids.some((id) => MERGED_INTO_MONEY.includes(id)) && !ids.includes("qa_money") ? [...ids, "qa_money"] : ids;
}

export function visibleQuickActionIds(role, visibility) {
  const override = visibility && Object.prototype.hasOwnProperty.call(visibility, role) ? visibility[role] : null;
  const allowed = Array.isArray(override) ? withMergedTiles(override) : defaultQuickActionIds(role);
  // Filtered through QUICK_ACTION_IDS so a stale id saved before a tile was
  // renamed or removed can never resurrect a tile that no longer exists.
  return QUICK_ACTION_IDS.filter((id) => allowed.includes(id));
}

// This person's own order of their Home buttons (Settings > Home buttons, saved on the server: users.home_tile_order). The ids they put
// in order come first in that order, any other visible tile follows in the standard order; an id that is not visible is ignored.
export function orderHomeTiles(ids, order) {
  if (!Array.isArray(order) || !order.length) return ids;
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...ids].sort((a, b) => (rank.get(a) ?? 1e6 + ids.indexOf(a)) - (rank.get(b) ?? 1e6 + ids.indexOf(b)));
}
