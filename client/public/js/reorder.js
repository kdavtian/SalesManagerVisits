// "Order usual" / "Reorder" helpers shared by the customer list/map, check-in result, task sheet,
// order detail sheets and the order screen. Data comes from GET /api/customers/:id/reorder-profile
// (server/src/customerReorder.js); the ordering rhythm chip from the customer list / map facts.
import { api } from "./api.js";
import { t } from "./i18n.js";

// "Reorder due" chip: gentle blue when the usual gap has passed, warm when it is clearly late.
export function reorderChipHtml(row) {
  if (!row || (row.reorder_state !== "due" && row.reorder_state !== "late")) return "";
  return `<span class="badge ${row.reorder_state === "late" ? "badge-warning" : "badge-info"}">${t("reorder_chip")}</span>`;
}

// The secondary text that sits behind the "!" (never printed inline).
export function reorderRhythmText(cadence) {
  if (!cadence?.median_gap_days || cadence.days_since_order == null) return "";
  return t("reorder_rhythm_info").replace("{gap}", String(cadence.median_gap_days)).replace("{days}", String(cadence.days_since_order));
}

export const usualOrderHash = (customerId) => `#/orders/new/${customerId}?usual=1`;
// source = "erp:<order id>" or "app:<order id>"
export const reorderHash = (customerId, source) => `#/orders/new/${customerId}?from=${encodeURIComponent(source)}`;

export async function loadReorderProfile(customerId, from = null) {
  try {
    return await api.getReorderProfile(customerId, from);
  } catch {
    return null; // offline or not allowed: the reorder shortcuts simply stay hidden
  }
}
