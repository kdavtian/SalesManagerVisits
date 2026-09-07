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
  "admin",
];

// defaultRoles is the role set each tile shipped with (previously an inline
// ternary per tile in dashboard.js). It stays the fallback forever: a role
// with no admin-saved override renders exactly what it rendered before this
// feature existed.
export const QUICK_ACTIONS = [
  { id: "qa_check_in", defaultRoles: ALL_ROLES },
  { id: "qa_plan_route", defaultRoles: ALL_ROLES },
  { id: "qa_add_customer", defaultRoles: ALL_ROLES },
  {
    id: "qa_payments",
    defaultRoles: ALL_ROLES.filter((r) => r !== "warehouse_manager" && r !== "delivery_manager"),
  },
  { id: "qa_cash_expense", defaultRoles: ALL_ROLES },
  { id: "qa_pricelist", defaultRoles: ALL_ROLES },
  // Sales Director included alongside Warehouse Manager/admin -- the
  // warehouse manager role isn't currently using the app, so the director
  // covers the same ground for now (see canManageWarehouse in
  // server/src/roles.js).
  { id: "qa_warehouse", defaultRoles: ["warehouse_manager", "sales_director", "admin"] },
  { id: "qa_delivery", defaultRoles: ["delivery_manager", "admin"] },
  { id: "qa_recorded", defaultRoles: ["admin", "ceo", "accountant"] },
  { id: "qa_team_performance", defaultRoles: ["admin", "ceo", "sales_director", "accountant", "sales_manager"] },
  { id: "qa_reports", defaultRoles: ALL_ROLES },
  { id: "qa_debt_balances", defaultRoles: ["admin", "ceo", "sales_director", "accountant", "sales_manager"] },
  { id: "qa_company_dashboard", defaultRoles: ["admin", "ceo", "sales_director", "accountant"] },
];

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
