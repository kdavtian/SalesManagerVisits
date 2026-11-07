// "Add a new product" in a few taps (owner, 2026-11-07: admin and accountants). The fields are the Excel Products sheet's own: brand, name,
// size in liters (stored as "4L", the way the Excel sync writes it), family, Bronze / Silver / Retail prices and the HC code. When the Excel later
// has a product with the same brand, name and size, the sync links to this one instead of adding a second (erpSync.js claim step), so the
// stock and prices continue on the same product. A product with the same brand, name and size already in the app is refused (409) unless
// the person confirms it is a different one.
import { api } from "./api.js";
import { t } from "./i18n.js";
import { activateDialog, bindAmdInput, compressImage, escapeHtml, parseAmd, showToast } from "./util.js";
import { CATEGORY_LABEL_KEY } from "./productBrowse.js";

// the categories a new product can be put in (owner, 2026-11-07); stored as the product's family, as the Excel does
const PA_CATEGORIES = ["Engine oil", "Transmission", "Brake fluid", "Hydraulic", "Antifreeze", "Grease", "EV fluids", "Merch", "Other"];

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
          <label>${t("pa_category")}
            <select name="category">${PA_CATEGORIES.map((c) => `<option value="${c}">${escapeHtml(t(CATEGORY_LABEL_KEY[c]))}</option>`).join("")}</select>
          </label>
          <label>${t("pa_size_l")}<input name="size" inputmode="decimal" placeholder="4" /></label>
        </div>
        <label id="pa-line-wrap">${t("pa_family")}<input name="family" list="pa-families" maxlength="40" placeholder="Edge, Magnatec, GTX…" /></label>
        <datalist id="pa-families">${families.map((f) => `<option value="${escapeHtml(f)}"></option>`).join("")}</datalist>
        <div class="pa-two">
          <label>${t("tier_bronze")}<input name="bronze" class="amd-input" inputmode="numeric" /></label>
          <label>${t("tier_silver")}<input name="silver" class="amd-input" inputmode="numeric" placeholder="${t("pa_silver_hint")}" /></label>
        </div>
        <div class="pa-two">
          <label>${t("price_retail")}<input name="retail" class="amd-input" inputmode="numeric" placeholder="${t("pa_retail_hint")}" /></label>
          <label>${t("pa_hc_code")}<input name="hc_code" inputmode="numeric" maxlength="20" /></label>
        </div>
        <label class="pa-photo">${t("pa_photo")}<input type="file" name="photo" accept="image/*" /></label>
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
  // the product line only means something for engine oil (Edge, Magnatec...); every other category is the family itself
  const categoryEl = form.querySelector('[name="category"]');
  const paintCategory = () => {
    overlay.querySelector("#pa-line-wrap").hidden = categoryEl.value !== "Engine oil";
  };
  categoryEl.addEventListener("change", paintCategory);
  paintCategory();
  form.querySelector('[name="brand"]').focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const sizeText = String(data.get("size") || "").trim();
    const size = sizeText ? Number(sizeText.replace(",", ".")) : null;
    const category = String(data.get("category"));
    const bronze = parseAmd(data.get("bronze"));
    errorEl.hidden = true;
    // a size is needed for what is sold by the liter; merch (a stand, a cap) has none
    if ((size === null && category !== "Merch") || (size !== null && (!Number.isFinite(size) || size <= 0))) {
      errorEl.textContent = t("pa_size_invalid");
      errorEl.hidden = false;
      return;
    }
    if (!(bronze > 0) && category !== "Merch") {
      errorEl.textContent = t("pa_price_invalid");
      errorEl.hidden = false;
      return;
    }
    saveBtn.disabled = true;
    try {
      const product = await api.createProduct({
        brand: String(data.get("brand")).trim(),
        name: String(data.get("name")).trim(),
        unit: size ? `${size}L` : null,
        size_l: size,
        family: category === "Engine oil" ? String(data.get("family") || "").trim() || "Engine Oil" : category,
        unit_price_amd: bronze ?? 0,
        bronze_price_amd: bronze ?? 0,
        silver_price_amd: parseAmd(data.get("silver")) ?? bronze ?? 0,
        retail_price_amd: parseAmd(data.get("retail")) ?? null,
        hc_code: String(data.get("hc_code") || "").trim() || null,
        allow_duplicate: confirmDuplicate,
      });
      // the photo goes up right after the product exists (the server keeps it as the main photo)
      const photo = form.querySelector('[name="photo"]').files[0];
      if (photo) {
        const body = new FormData();
        body.append("kind", "front");
        body.append("image", await compressImage(photo, { maxDimension: 1600, quality: 0.82 }).catch(() => photo), "photo.jpg");
        await api.uploadProductPhoto(product.id, body).catch(() => showToast(t("pa_photo_failed")));
      }
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
