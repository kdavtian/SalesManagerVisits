// Bulk actions of the Orders page (long press an order -> select several -> one bottom sheet). Each action is the
// same call the single order's buttons make (orderDetailSheet.js), applied one order at a time to the selected
// orders it fits; the result says how many worked and why the others did not.
import { api } from "./api.js";
import { state } from "./state.js";
import { canConfirmOrders, canConfirmSubmittedOrders, canMarkDeliveredWithoutRoute } from "./shared/roles.js";

// key, i18n label, which orders it fits, how to run it on one order
export const BULK_ACTIONS = [
  {
    key: "approve-discount",
    labelKey: "approve_price_change",
    primary: false,
    fits: (o) => canConfirmOrders(state.user.role) && o.approval_status === "pending",
    run: (o) => api.approveOrderDiscount(o.id),
  },
  {
    key: "approve-credit",
    labelKey: "approve_credit",
    primary: false,
    fits: (o) => canConfirmSubmittedOrders(state.user.role) && o.credit_status === "pending",
    run: (o) => api.approveOrderCredit(o.id),
  },
  {
    key: "confirm",
    labelKey: "confirm_order",
    primary: true,
    fits: (o) => canConfirmSubmittedOrders(state.user.role) && o.status === "submitted" && o.approval_status !== "pending" && o.credit_status !== "pending",
    run: (o) => api.updateOrderStatus(o.id, "confirmed"),
  },
  {
    key: "deliver",
    labelKey: "bulk_mark_delivered",
    primary: true,
    fits: (o) => canMarkDeliveredWithoutRoute(state.user.role) && (o.status === "confirmed" || o.status === "packed_stock_out"),
    run: (o) => api.markOrderDeliveredWithoutRoute(o.id),
  },
  {
    key: "reject",
    labelKey: "reject_order",
    primary: false,
    danger: true,
    needsNote: true,
    fits: (o) => canConfirmOrders(state.user.role) && o.status === "submitted",
    run: (o, note) => api.rejectOrder(o.id, note),
  },
];

export const availableBulkActions = (selectedOrders) =>
  BULK_ACTIONS.map((a) => ({ ...a, orders: selectedOrders.filter(a.fits) })).filter((a) => a.orders.length);

// Runs one action over its orders; onProgress(done, total). Returns { ok, failed: [{ order, message }] }.
export async function runBulkAction(action, orders, { note = "", onProgress } = {}) {
  let ok = 0;
  const failed = [];
  for (const [i, order] of orders.entries()) {
    onProgress?.(i, orders.length);
    try {
      await action.run(order, note);
      ok++;
    } catch (err) {
      failed.push({ order, message: err.message });
    }
  }
  onProgress?.(orders.length, orders.length);
  return { ok, failed };
}
