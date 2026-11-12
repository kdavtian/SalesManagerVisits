// Small order badges shared by screens that must not pull in the whole order sheet (and its text areas): the Recorded list, the orders list,
// the order sheet itself.
import { t } from "./i18n.js";
import { escapeHtml } from "./util.js";

// Delivered or later: Recorded (the final status, owner 2026-11-11) is a delivered order the accountant has booked -- everything a delivered
// order offers (re-order, return, correction) a recorded one offers too. The server twin is server/src/orders/orderRecord.js isDone.
export const isDone = (status) => status === "delivered" || status === "recorded";

// "Checked" (owner, 2026-11-12): Vaghinak read the order's signed paper and it matches (server: orders/vaghinakChecked.js). A tick so the state is
// not told by colour alone.
export function vaghinakCheckedBadgeHtml(order) {
  return order?.vaghinak_checked ? `<span class="badge badge-recorded" title="${escapeHtml(t("vaghinak_checked_hint"))}">✓ ${t("vaghinak_checked_badge")}</span>` : "";
}

// "Not in Excel" (owner, 2026-11-11): delivered, but the Excel still does not show it after 14 days -- the accountant has it on their list.
export function notInExcelBadgeHtml(order) {
  return order?.not_in_excel_at ? `<span class="badge badge-danger" title="${t("not_in_excel_hint")}">${t("not_in_excel_badge")}</span>` : "";
}
