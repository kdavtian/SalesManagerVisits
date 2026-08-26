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
