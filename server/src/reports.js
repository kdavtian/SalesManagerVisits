import { pool } from "./db/pool.js";

// The fixed set of named reports this app can show -- new ones just get
// added here (with a matching i18n key for the name/description and a
// data route in routes/reports.js). defaultRoles is who sees it before an
// admin overrides anything in report_access -- office roles by default,
// since a plain sales manager has no reason to see org-wide reports on
// their own customers unless admin explicitly grants it.
export const REPORTS = [
  {
    key: "new_customers",
    nameKey: "report_new_customers_name",
    descriptionKey: "report_new_customers_description",
    defaultRoles: ["admin", "ceo", "sales_director"],
  },
  {
    key: "checkins",
    nameKey: "report_checkins_name",
    descriptionKey: "report_checkins_description",
    defaultRoles: ["admin", "ceo", "sales_director"],
  },
  {
    key: "brand_availability",
    nameKey: "report_brand_availability_name",
    descriptionKey: "report_brand_availability_description",
    defaultRoles: ["admin", "ceo", "sales_director"],
  },
  {
    key: "payments",
    nameKey: "report_payments_name",
    descriptionKey: "report_payments_description",
    // Accountant is the one who actually reconciles these day to day --
    // included here even though they're outside the usual office-roles set
    // for other reports, same reasoning as canReviewPayments in roles.js.
    defaultRoles: ["admin", "ceo", "sales_director", "accountant"],
  },
  // The next three surface the same Castrol ERP extract that already feeds
  // erp_customer_data/sales_performance/perf_actuals_brand_monthly (see
  // erpSync.js) as in-app reports -- previously that data was only ever
  // seen as a formatted summary from a separate Telegram bot outside this
  // app, run from the same Windows PC that pushes the sync payload here.
  {
    key: "customer_debt",
    nameKey: "report_customer_debt_name",
    descriptionKey: "report_customer_debt_description",
    // Accountant reconciles debt day to day, same reasoning as payments above.
    defaultRoles: ["admin", "ceo", "sales_director", "accountant"],
  },
  {
    key: "sales_budget",
    nameKey: "report_sales_budget_name",
    descriptionKey: "report_sales_budget_description",
    defaultRoles: ["admin", "ceo", "sales_director"],
  },
  {
    key: "brand_volume",
    nameKey: "report_brand_volume_name",
    descriptionKey: "report_brand_volume_description",
    defaultRoles: ["admin", "ceo", "sales_director"],
  },
  // Fed by its own daily push (POST /api/erp-sync/daily-report), separate
  // from the extract above -- the CEO Telegram bot's own daily
  // sales/collections/balance summary, computed on the sync PC and browsable
  // here instead of only ever sent as a Telegram message.
  {
    key: "daily_management",
    nameKey: "report_daily_management_name",
    descriptionKey: "report_daily_management_description",
    defaultRoles: ["admin", "ceo", "sales_director", "accountant"],
  },
  // Downloadable generated files (Sales Director workbook, debt/receivables
  // Excel, CEO management workbook) pushed as-is by the bot -- see
  // erpSync.js's POST /reports and roles.js's seesGeneratedReports. Not
  // parsed into structured columns like the reports above; this just lists
  // and serves whatever files have landed.
  {
    key: "documents",
    nameKey: "report_documents_name",
    descriptionKey: "report_documents_description",
    defaultRoles: ["admin", "ceo", "sales_director", "accountant"],
  },
];

export function findReport(key) {
  return REPORTS.find((r) => r.key === key);
}

// report_access has no row for most role/report pairs -- that means "use
// the report's own defaultRoles", not "denied". A row only exists once an
// admin has explicitly overridden that pair.
export async function canAccessReport(role, reportKey) {
  if (role === "admin") return true;
  const report = findReport(reportKey);
  if (!report) return false;
  const { rows } = await pool.query(
    "SELECT enabled FROM report_access WHERE report_key = $1 AND role = $2",
    [reportKey, role]
  );
  if (rows.length) return rows[0].enabled;
  return report.defaultRoles.includes(role);
}
