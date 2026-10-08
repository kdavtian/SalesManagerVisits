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
  { id: "qa_add_customer", defaultRoles: ALL_ROLES },
  {
    id: "qa_payments",
    defaultRoles: ALL_ROLES.filter((r) => r !== "warehouse_manager" && r !== "delivery_manager"),
  },
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
  // Sales Director and CEO/Operations Director included alongside
  // Warehouse Manager/admin -- the warehouse manager role isn't currently
  // using the app, so the director covers the same ground for now, and
  // CEO/Operations Director get the same broad operational visibility
  // they already have everywhere else. Accountant included too --
  // inventory is financial data, same access line seesFinancialExports
  // already draws elsewhere (see canManageWarehouse in server/src/roles.js,
  // which this list must stay in sync with).
  {
    id: "qa_warehouse",
    defaultRoles: ["warehouse_manager", "sales_director", "ceo", "operations_director", "accountant", "admin"],
  },
  // Waybills / invoices from accounting. Everyone: a rep sees only their own
  // orders (server-side), the warehouse needs the document before it hands
  // the goods to delivery.
  { id: "qa_accounting", defaultRoles: ALL_ROLES },
  { id: "qa_pricelist", defaultRoles: ALL_ROLES },
  // Same visibility as the financial exports/Company Dashboard -- raw
  // per-order ERP revenue is the same sensitivity class (see
  // seesFinancialExports in server/src/roles.js, which server/src/routes/
  // sales.js gates on too). A sales_manager already has their own
  // customers' order history via the customer detail page.
  { id: "qa_sales", defaultRoles: ["admin", "ceo", "operations_director", "sales_director", "accountant"] },
  { id: "qa_cash_expense", defaultRoles: ALL_ROLES },
  { id: "qa_recorded", defaultRoles: ["admin", "ceo", "operations_director", "accountant"] },
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
  qa_payments: "#/payments",
  qa_cash_expense: "#/expenses",
  qa_pricelist: "#/pricelist",
  qa_warehouse: "#/warehouse",
  qa_accounting: "#/accounting",
  qa_delivery: "#/delivery",
  qa_recorded: "#/recorded",
  qa_team_performance: "#/team-performance",
  qa_reports: "#/reports",
  qa_debt_balances: "#/debt-balances",
  qa_company_dashboard: "#/company-dashboard",
  qa_sales: "#/sales",
  qa_tasks: "#/tasks",
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
export function visibleQuickActionIds(role, visibility) {
  const override = visibility && Object.prototype.hasOwnProperty.call(visibility, role) ? visibility[role] : null;
  const allowed = Array.isArray(override) ? override : defaultQuickActionIds(role);
  // Filtered through QUICK_ACTION_IDS so a stale id saved before a tile was
  // renamed or removed can never resurrect a tile that no longer exists.
  return QUICK_ACTION_IDS.filter((id) => allowed.includes(id));
}
