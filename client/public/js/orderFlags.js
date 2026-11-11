// Small order badges shared by screens that must not pull in the whole order sheet (and its text areas): the Recorded list, the orders list,
// the order sheet itself.
import { t } from "./i18n.js";

// "Not in Excel" (owner, 2026-11-11): delivered, but the Excel still does not show it after 14 days -- the accountant has it on their list.
export function notInExcelBadgeHtml(order) {
  return order?.not_in_excel_at ? `<span class="badge badge-danger" title="${t("not_in_excel_hint")}">${t("not_in_excel_badge")}</span>` : "";
}
