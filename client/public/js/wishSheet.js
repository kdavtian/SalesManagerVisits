// "Wish" sheet (owner, 2026-10-28): an order holds only what is on the shelf; a product the customer wants but we do not have is written
// down as a wish -- an out-of-stock catalog product, or a product we never carried (typed name). Management reads them in Reports >
// Wished products and is notified; the rep is told when a wished product is back (server: productWishes.js).
import { api } from "./api.js";
import { t } from "./i18n.js";
import { escapeHtml, activateDialog, showToast } from "./util.js";

// product: a catalog product (out of stock) or null for a new one; name: the text to start a new one with (the search the rep typed).
// Resolves with the saved wish, or null when the sheet was closed.
export function openWishSheet({ customerId, product = null, name = "" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet wish-sheet" role="dialog" aria-labelledby="wish-title">
        <h2 id="wish-title">${escapeHtml(t(product ? "wish_title_product" : "wish_title_new"))}</h2>
        <form id="wish-form">
          ${
            product
              ? `<p class="wish-product"><strong>${escapeHtml(product.name)}</strong>${product.unit ? ` <span class="muted">${escapeHtml(product.unit)}</span>` : ""}<br /><span class="badge badge-danger">${t("out_of_stock")}</span></p>`
              : `<label>${t("wish_name_label")}<input name="custom_name" maxlength="120" required autocomplete="off" value="${escapeHtml(name)}" placeholder="${escapeHtml(t("wish_name_placeholder"))}" /></label>`
          }
          <label>${t("wish_qty_label")}<input name="quantity" type="number" inputmode="numeric" min="1" step="1" value="1" required /></label>
          <label>${t("wish_note_label")}<input name="note" maxlength="300" autocomplete="off" /></label>
          <p class="muted wish-hint">${escapeHtml(t("wish_hint"))}</p>
          <p class="form-error" id="wish-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="wish-cancel">${t("cancel")}</button>
            <button type="submit" class="btn btn-primary">${t("wish_save")}</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    const close = (value) => {
      overlay.remove();
      resolve(value);
    };
    overlay.querySelector("#wish-cancel").addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => e.target === overlay && close(null));
    const form = overlay.querySelector("#wish-form");
    const errorEl = overlay.querySelector("#wish-error");
    (form.querySelector('[name="custom_name"]') ?? form.querySelector('[name="quantity"]')).focus();
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      errorEl.hidden = true;
      try {
        const data = new FormData(form);
        const saved = await api.addWish({
          customer_id: Number(customerId),
          ...(product ? { product_id: product.id } : { custom_name: String(data.get("custom_name") || "").trim() }),
          quantity: Number(data.get("quantity")) || 1,
          note: String(data.get("note") || "").trim() || undefined,
        });
        showToast(t("wish_saved"));
        close(saved);
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submit.disabled = false;
      }
    });
  });
}
