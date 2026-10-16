// "Order usual" / "Reorder" helpers shared by the customer card, customer list/map, check-in result, task sheet,
// order detail sheets and the order screen. Data comes from GET /api/customers/:id/reorder-profile
// (server/src/customerReorder.js); the ordering rhythm chip from the customer list / map facts.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { escapeHtml, formatAmd, openInfoPopup } from "./util.js";
import { getProductCatalog } from "./productCatalog.js";
import { tierPrice } from "./productPricing.js";

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

// Estimated value of the usual basket at today's tier prices (individually negotiated gold prices are applied
// by the server when the order is saved, so this is shown with a "~").
export async function usualEstimateAmd(items, tier) {
  try {
    const catalog = await getProductCatalog();
    const byId = new Map(catalog.map((p) => [p.id, p]));
    let total = 0;
    for (const item of items) {
      const product = byId.get(item.product_id);
      if (product) total += tierPrice(product, tier || "potential") * item.quantity;
    }
    return Math.round(total);
  } catch {
    return 0;
  }
}

// Compact row on the customer card: title + count/value, the rhythm note behind "!", and the one-tap button.
// Hidden entirely when the customer has no usual basket. Shows at once; the value estimate joins it later.
export async function mountUsualSlot(slot, customer, navigate) {
  if (!slot) return;
  const profile = await loadReorderProfile(customer.id);
  if (!profile?.items?.length) {
    slot.innerHTML = "";
    return;
  }
  const note = reorderRhythmText(profile.cadence);
  const due = profile.cadence.state === "due" || profile.cadence.state === "late";
  slot.innerHTML = `
    <div class="card usual-order-card${due ? " usual-order-card-due" : ""}">
      <div class="usual-order-text">
        <div class="usual-order-title"><strong>${t("usual_order_title")}</strong>${
          note ? `<button type="button" class="settings-hint-icon" data-usual-info aria-label="${t("more_info")}">!</button>` : ""
        }</div>
        <div class="muted usual-order-sub">${due ? `<span class="badge ${profile.cadence.state === "late" ? "badge-warning" : "badge-info"}">${t("reorder_chip")}</span> ` : ""}<span data-usual-count>${profile.items.length} ${t("usual_order_items")}</span></div>
      </div>
      <button type="button" class="btn btn-primary" data-usual-order>${t("usual_order_btn_short")}</button>
    </div>`;
  slot.querySelector("[data-usual-order]").addEventListener("click", () => navigate(usualOrderHash(customer.id)));
  // The strip is up as soon as the basket is known; the "~amount" (needs the product catalog, one more request) is
  // added to the same line when it arrives -- it never holds the strip back.
  usualEstimateAmd(profile.items, customer.customer_tier).then((amount) => {
    const countEl = slot.querySelector("[data-usual-count]");
    if (amount && countEl?.isConnected) countEl.textContent = `${profile.items.length} ${t("usual_order_items")} · ~${formatAmd(amount)}`;
  });
  slot.querySelector("[data-usual-info]")?.addEventListener("click", () => openInfoPopup(`<p>${escapeHtml(note)}</p>`));
}
