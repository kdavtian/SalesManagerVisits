// Every kind of notification the app sends, grouped as Settings > Notifications shows them, with the roles that can receive each kind
// (owner, 2026-10-28: "1A" -- every kind can be switched off, by the person and by the admin's per-role defaults; a person sees only
// the kinds their role gets). Shared by the server (notificationPreferences.js: the list the on/off choices are stored against) and the
// Settings screen. A new kind: add it here with its audience, plus notification_type_<kind> in both i18n files.
const ALL = ["admin", "ceo", "operations_director", "sales_director", "sales_manager", "warehouse_manager", "delivery_manager", "accountant"];
const MANAGEMENT = ["admin", "ceo", "operations_director", "sales_director", "accountant"];

export const NOTIFICATION_GROUPS = [
  {
    key: "orders",
    types: [
      { type: "order_placed", roles: ["admin", "ceo", "operations_director", "sales_director", "sales_manager", "accountant"] },
      { type: "order_status_changed", roles: ["admin", "ceo", "operations_director", "sales_director", "sales_manager", "accountant"] },
      { type: "order_warehouse_review", roles: ["admin", "warehouse_manager"] },
      { type: "order_stock_issue", roles: ["admin", "ceo", "operations_director", "sales_director"] },
      { type: "order_packed", roles: ["admin", "delivery_manager"] },
      { type: "order_delivered", roles: ["admin", "sales_director", "warehouse_manager"] },
      { type: "order_returned", roles: ["admin", "sales_director", "warehouse_manager"] },
      { type: "order_stale_packed", roles: ["admin", "warehouse_manager"] },
      { type: "accounting_update", roles: MANAGEMENT },
      // the AI check of a photographed order blank found a problem (aiBlankCheck.js): told to the person who took it
      { type: "document_issue", roles: ["admin", "ceo", "operations_director", "sales_director", "sales_manager", "delivery_manager", "accountant"] },
      // the Excel sync changed prices (one notification per sync, priceSyncLog.js)
      { type: "price_changed", roles: ["admin", "sales_director", "sales_manager"] },
      // wished products (productWishes.js): a new wish for management, "available again" for the customer's rep
      { type: "product_wish", roles: ["admin", "ceo", "operations_director", "sales_director"] },
      { type: "wish_back_in_stock", roles: ["admin", "sales_director", "sales_manager"] },
    ],
  },
  {
    key: "money",
    types: [
      { type: "payment_submitted", roles: ["admin", "accountant"] },
      // cash custody chain (migration 059): the receiver is asked to count and confirm, the sender learns the outcome
      { type: "cash_handoff_submitted", roles: ["admin", "ceo", "operations_director", "sales_director", "accountant"] },
      { type: "cash_handoff_reviewed", roles: ["admin", "ceo", "operations_director", "sales_director", "sales_manager"] },
      // Monday 09:00: total / overdue debt, change since last week, the biggest movers (debtDigest.js)
      { type: "debt_digest", roles: ["admin", "ceo", "sales_director"] },
      // anti-fraud findings for management and the "hand over your cash" reminder for a rep (antiFraud.js)
      { type: "fraud_alert", roles: ["admin", "ceo", "operations_director", "sales_manager"] },
      // expense findings and the Monday report (expenseWatch.js)
      { type: "expense_alert", roles: ["admin", "ceo", "operations_director", "accountant"] },
    ],
  },
  {
    key: "work",
    types: [
      { type: "task_assigned", roles: ALL },
      { type: "task_deadline", roles: ALL },
      { type: "task_completed", roles: ALL },
      // Vaghinak, the AI operations deputy: reminders, questions and day wrap-ups (vaghinak/engine.js)
      { type: "vaghinak", roles: ALL },
      { type: "visit_reminder", roles: ["admin", "sales_manager"] },
      { type: "plan_submitted", roles: ["admin", "ceo", "operations_director", "sales_director"] },
      { type: "plan_reviewed", roles: ["admin", "sales_manager"] },
      { type: "perf_plan_submitted", roles: ["admin", "ceo", "operations_director", "accountant"] },
      { type: "perf_plan_reviewed", roles: ["admin", "sales_director", "accountant"] },
    ],
  },
  {
    key: "reports",
    types: [
      // Monday 09:00: last week's numbers (scorecard.js)
      { type: "weekly_scorecard", roles: ["admin", "ceo", "operations_director", "sales_director", "sales_manager"] },
      // once-a-day digest of what is still unresolved (dailySummary.js)
      { type: "daily_summary", roles: MANAGEMENT },
      // the CEO bot's sync brought new reports (one notification per sync, erpSync.js / syncNotifier.js)
      { type: "sync_reports_ready", roles: MANAGEMENT },
      // the bot's sync did NOT arrive in time (erpSyncMonitor.js)
      { type: "erp_sync_stale", roles: ["admin", "ceo", "operations_director"] },
    ],
  },
];

// Kept so stored preferences stay valid; nothing sends it any more and Settings does not offer it.
const RETIRED = ["payment_due_soon"];

export const NOTIFICATION_TYPES = [...NOTIFICATION_GROUPS.flatMap((g) => g.types.map((t) => t.type)), ...RETIRED];

// The groups (and in each, the kinds) a role can receive; admin sees every kind.
export function notificationGroupsFor(role) {
  return NOTIFICATION_GROUPS.map((g) => ({ key: g.key, types: g.types.filter((t) => role === "admin" || t.roles.includes(role)).map((t) => t.type) })).filter((g) => g.types.length);
}
