// "Add a new product" in a few taps (owner, 2026-11-07: admin and accountants). The fields are the Excel Products sheet's own: brand, name,
// size in liters (stored as "4L", the way the Excel sync writes it), family, Bronze / Silver / Retail prices and the HC code. When the Excel later
// has a product with the same brand, name and size, the sync links to this one instead of adding a second (erpSync.js claim step), so the
// stock and prices continue on the same product. A product with the same brand, name and size already in the app is refused (409) unless
// the person confirms it is a different one.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { activateDialog, bindAmdInput, escapeHtml, parseAmd } from "./util.js";

const uniqueSorted = (values) => [...new Set(values.map((v) => String(v || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));

/** Opens the sheet; `onSaved(product)` runs after the product is created. */
export async function openAddProductSheet({ onSaved } = {}) {
  let catalog = [];
  try {
    catalog = await api.listProducts();
  } catch {
    // the lists below are only suggestions
  }
  const brands = uniqueSorted(catalog.map((p) => p.brand));
  const families = uniqueSorted(catalog.map((p) => p.family));
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `
    <div class="sheet product-add-sheet">
      <h2>${t("pa_title")}</h2>
      <form id="pa-form" autocomplete="off">
        <label>${t("brand")}<input name="brand" list="pa-brands" required maxlength="60" /></label>
        <datalist id="pa-brands">${brands.map((b) => `<option value="${escapeHtml(b)}"></option>`).join("")}</datalist>
        <label>${t("product_name")}<input name="name" required maxlength="120" placeholder="${t("pa_name_hint")}" /></label>
        <div class="pa-two">
          <label>${t("pa_size_l")}<input name="size" inputmode="decimal" required placeholder="4" /></label>
          <label>${t("pa_family")}<input name="family" list="pa-families" maxlength="40" /></label>
        </div>
        <datalist id="pa-families">${families.map((f) => `<option value="${escapeHtml(f)}"></option>`).join("")}</datalist>
        <div class="pa-two">
          <label>${t("tier_bronze")}<input name="bronze" class="amd-input" inputmode="numeric" required /></label>
          <label>${t("tier_silver")}<input name="silver" class="amd-input" inputmode="numeric" placeholder="${t("pa_silver_hint")}" /></label>
        </div>
        <div class="pa-two">
          <label>${t("price_retail")}<input name="retail" class="amd-input" inputmode="numeric" placeholder="${t("pa_retail_hint")}" /></label>
          <label>${t("pa_hc_code")}<input name="hc_code" inputmode="numeric" maxlength="20" /></label>
        </div>
        <p class="muted pa-note">${t("pa_link_note")}</p>
        <p class="form-error" id="pa-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn" id="pa-cancel">${t("cancel")}</button>
          <button type="submit" class="btn btn-primary" id="pa-save">${t("save")}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.querySelector("#pa-cancel").addEventListener("click", close);
  const form = overlay.querySelector("#pa-form");
  form.querySelectorAll(".amd-input").forEach((el) => bindAmdInput(el));
  const errorEl = overlay.querySelector("#pa-error");
  const saveBtn = overlay.querySelector("#pa-save");
  let confirmDuplicate = false;
  // a change after the "already exists" warning asks again
  form.addEventListener("input", () => {
    if (!confirmDuplicate) return;
    confirmDuplicate = false;
    saveBtn.textContent = t("save");
    errorEl.hidden = true;
  });
  form.querySelector('[name="brand"]').focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const size = Number(String(data.get("size") || "").replace(",", "."));
    const bronze = parseAmd(data.get("bronze"));
    errorEl.hidden = true;
    if (!Number.isFinite(size) || size <= 0) {
      errorEl.textContent = t("pa_size_invalid");
      errorEl.hidden = false;
      return;
    }
    if (!(bronze > 0)) {
      errorEl.textContent = t("pa_price_invalid");
      errorEl.hidden = false;
      return;
    }
    saveBtn.disabled = true;
    try {
      const product = await api.createProduct({
        brand: String(data.get("brand")).trim(),
        name: String(data.get("name")).trim(),
        unit: `${size}L`,
        size_l: size,
        family: String(data.get("family") || "").trim() || null,
        unit_price_amd: bronze,
        bronze_price_amd: bronze,
        silver_price_amd: parseAmd(data.get("silver")) ?? bronze,
        retail_price_amd: parseAmd(data.get("retail")) ?? null,
        hc_code: String(data.get("hc_code") || "").trim() || null,
        allow_duplicate: confirmDuplicate,
      });
      close();
      onSaved?.(product);
    } catch (err) {
      saveBtn.disabled = false;
      if (err.body?.code === "duplicate") {
        // same brand + name + size already there: say which, and let a second tap save it anyway
        confirmDuplicate = true;
        saveBtn.textContent = t("pa_save_anyway");
        errorEl.textContent = t("pa_duplicate").replace("{name}", err.body.existing?.name ?? "");
      } else errorEl.textContent = err.message;
      errorEl.hidden = false;
    }
  });
}
