// Special pricelist of a Gold customer (Customer settings -> Special pricelist). The same product browser as the New
// order screen (chips: favorites, Frequent, Special prices, brands, Merch; search; categories), but every card has a
// price field instead of "Add". A field left empty means "the Gold list price"; the chip beside it is the difference to
// the SILVER price. Changed fields raise a bottom sheet: Cancel (drop the edits), Reset (every price to Silver),
// Submit (save). New orders for this customer pick these prices automatically.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { escapeHtml, groupDigits, bindAmdInput, tierBadgeHtml, showToast, openInfoPopup } from "../util.js";
import { compareProducts, sortedBrands } from "../productSort.js";
import { getProductCatalog } from "../productCatalog.js";
import { searchProducts, debounce } from "../productSearch.js";
import { tierPrice } from "../productPricing.js";
import { loadFavorites, setFavorite, loadFrequentIds } from "../productFavorites.js";
import { NON_ENGINE_CATEGORIES, CATEGORY_LABEL_KEY, productCategory, STAR_SVG, priceDiffChipHtml } from "../productBrowse.js";
import { canSetCustomerPrices } from "../state.js";

const MERCH = "__merch__";

export async function renderSpecialPrices(root, navigate, customerId) {
  root.innerHTML = `<div class="detail-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const container = root.querySelector(".detail-view");
  let customer, products, saved;
  try {
    [customer, products, saved] = await Promise.all([api.getCustomer(customerId), getProductCatalog(), api.getCustomerProductPrices(customerId)]);
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (customer.customer_tier !== "gold" || !canSetCustomerPrices()) {
    container.innerHTML = `<p class="empty-state">${t("sp_gold_only")}</p>`;
    return;
  }

  const byId = new Map(products.map((p) => [p.id, p]));
  const special = new Map(saved.map((r) => [r.product_id, Number(r.price_amd)])); // what is saved on the server
  const edits = new Map(); // product id -> new number, or null = back to the Gold list price
  const goldList = (p) => tierPrice(p, "gold");
  const silverOf = (p) => tierPrice(p, "silver");
  const currentSpecial = (p) => (edits.has(p.id) ? edits.get(p.id) : special.has(p.id) ? special.get(p.id) : null);
  const isDirty = (p) => {
    if (!edits.has(p.id)) return false;
    const now = edits.get(p.id);
    const before = special.has(p.id) ? special.get(p.id) : null;
    // saving the Gold list price itself is the same as having no special price
    const effective = now != null && now === goldList(p) ? null : now;
    return effective !== before;
  };

  const view = { chip: "frequent", category: null };
  let searchQuery = "";
  let favorites = new Set();
  let frequentIds = [];
  let everOrdered = [];

  container.innerHTML = `
    <div class="detail-header oc-header">
      <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-title oc-title">
        <div class="sales-heading-with-hint"><h1>${t("sp_title")}</h1><button type="button" class="settings-hint-icon" id="sp-info" aria-label="${t("more_info")}">!</button></div>
        <span class="oc-customer">${escapeHtml(customer.name)} ${tierBadgeHtml("gold")}</span>
      </div>
    </div>
    <div class="oc-chips" id="oc-chips" role="group" aria-label="${t("oc_lists")}"></div>
    <div class="order-search-row">
      <input type="search" id="product-search" placeholder="${t("search_products_placeholder")}" aria-label="${t("search_products_placeholder")}" autocomplete="off" />
    </div>
    <div class="oc-chips oc-chips-small" id="oc-categories" hidden></div>
    <div class="order-product-list sp-list order-product-list-with-cart-bar" id="order-product-list"></div>
    <div class="order-cart-bar sp-bar" id="sp-bar" hidden>
      <div class="order-cart-summary"><span id="sp-count"></span></div>
      <div class="sp-bar-actions">
        <button type="button" class="btn" id="sp-cancel">${t("cancel")}</button>
        <button type="button" class="btn" id="sp-reset">${t("sp_reset")}</button>
        <button type="button" class="btn btn-primary" id="sp-submit">${t("sp_submit")}</button>
      </div>
    </div>`;
  const $ = (sel) => container.querySelector(sel);
  const chipsEl = $("#oc-chips");
  const categoriesEl = $("#oc-categories");
  const listEl = $("#order-product-list");
  const searchInput = $("#product-search");
  const bar = $("#sp-bar");

  $("#back-btn").addEventListener("click", () => navigate.goBack(`#/customers/${customerId}`));
  $("#sp-info").addEventListener("click", () => openInfoPopup(`<p>${t("sp_info_1")}</p><p>${t("sp_info_2")}</p><p>${t("sp_info_3")}</p>`));

  // ---- chips ---------------------------------------------------------------------------------------------------------
  const isMerch = (p) => productCategory(p) === "Merch";
  const brands = sortedBrands(products.filter((p) => !isMerch(p)));
  const chipKeys = ["special", ...brands, ...(products.some(isMerch) ? [MERCH] : [])];
  const chipProducts = (key) => products.filter((p) => (key === MERCH ? isMerch(p) : p.brand === key && !isMerch(p)));
  const specialCount = () => products.filter((p) => currentSpecial(p) != null).length;
  function renderChips() {
    const searching = Boolean(searchQuery.trim());
    const chip = (key, inner, aria) =>
      `<button type="button" class="map-filter-chip ${!searching && view.chip === key ? "chip-active" : ""}" data-chip="${escapeHtml(key)}" aria-pressed="${!searching && view.chip === key}" ${aria ? `aria-label="${escapeHtml(aria)}"` : ""}>${inner}</button>`;
    chipsEl.innerHTML =
      chip("fav", `${STAR_SVG(true)}${favorites.size ? `<span class="oc-chip-n">${favorites.size}</span>` : ""}`, t("oc_favorites")) +
      chip("frequent", escapeHtml(t("oc_frequent"))) +
      chipKeys
        .map((k) => {
          if (k === "special") return chip(k, `${escapeHtml(t("sp_chip_special"))}${specialCount() ? `<span class="oc-chip-n">${specialCount()}</span>` : ""}`);
          return chip(k, escapeHtml(k === MERCH ? t("category_merch") : k));
        })
        .join("");
    chipsEl.querySelectorAll("[data-chip]").forEach((btn) =>
      btn.addEventListener("click", () => {
        view.chip = btn.dataset.chip;
        view.category = null;
        if (searchQuery) {
          searchQuery = "";
          searchInput.value = "";
        }
        render();
        btn.scrollIntoView({ inline: "center", block: "nearest" });
      })
    );
  }

  // ---- list ------------------------------------------------------------------------------------------------------------
  const sortProducts = (list) => [...list].sort(compareProducts);
  function frequentList() {
    const out = [];
    const seen = new Set();
    const push = (p) => {
      if (p && !seen.has(p.id)) {
        out.push(p);
        seen.add(p.id);
      }
    };
    for (const r of everOrdered) push(byId.get(r.product_id));
    if (!out.length) for (const id of frequentIds) push(byId.get(id));
    return out;
  }
  function baseList() {
    if (searchQuery.trim()) return sortProducts(searchProducts(products, searchQuery));
    if (view.chip === "fav") return sortProducts(products.filter((p) => favorites.has(p.id)));
    if (view.chip === "frequent") return frequentList();
    if (view.chip === "special") return sortProducts(products.filter((p) => currentSpecial(p) != null));
    return sortProducts(chipProducts(view.chip));
  }
  function renderCategories(list) {
    const present = new Set(list.map(productCategory));
    const cats = ["Engine oil", ...NON_ENGINE_CATEGORIES].filter((c) => present.has(c));
    if (view.category && !present.has(view.category)) view.category = null;
    categoriesEl.hidden = cats.length < 2;
    categoriesEl.innerHTML =
      cats.length < 2
        ? ""
        : [{ value: null, label: t("category_all") }, ...cats.map((c) => ({ value: c, label: t(CATEGORY_LABEL_KEY[c]) }))]
            .map((c) => `<button type="button" class="map-filter-chip ${view.category === c.value ? "chip-active" : ""}" data-category="${c.value ?? ""}" aria-pressed="${view.category === c.value}">${escapeHtml(c.label)}</button>`)
            .join("");
    categoriesEl.querySelectorAll("[data-category]").forEach((btn) =>
      btn.addEventListener("click", () => {
        view.category = btn.dataset.category || null;
        render();
      })
    );
  }

  function rowHtml(p) {
    const cur = currentSpecial(p);
    const fav = favorites.has(p.id);
    const gold = goldList(p);
    const silver = silverOf(p);
    return `<div class="order-product-row sp-row ${isDirty(p) ? "is-dirty" : ""}" data-product-id="${p.id}">
      <button type="button" class="oc-star ${fav ? "is-fav" : ""}" data-action="star" aria-pressed="${fav}" aria-label="${fav ? t("oc_remove_favorite") : t("oc_add_favorite")}">${STAR_SVG(fav)}</button>
      <div class="order-product-info">
        <strong>${escapeHtml(p.name)}</strong>
        <span class="muted">${[p.brand, p.unit].filter(Boolean).map(escapeHtml).join(" · ")}</span>
        <span class="muted sp-lists">${t("tier_silver")} ${groupDigits(silver)} · ${t("tier_gold")} ${groupDigits(gold)}</span>
      </div>
      <div class="sp-side">
        <div class="sp-field">
          <input class="oc-field amd-input sp-input" data-price placeholder="${groupDigits(gold)}" value="${cur != null ? groupDigits(cur) : ""}" aria-label="${escapeHtml(p.name)}" />
          <span class="sp-chip-slot">${cur != null ? priceDiffChipHtml(cur, silver) : ""}</span>
        </div>
      </div>
    </div>`;
  }

  function wireRow(row, p) {
    row.querySelector('[data-action="star"]').addEventListener("click", async () => {
      const on = !favorites.has(p.id);
      const ok = await setFavorite(favorites, p.id, on);
      showToast(ok ? (on ? t("oc_favorite_added") : t("oc_favorite_removed")) : t("oc_favorite_failed"));
      if (view.chip === "fav" && !searchQuery.trim()) render();
      else {
        row.querySelector(".oc-star").classList.toggle("is-fav", favorites.has(p.id));
        row.querySelector(".oc-star").innerHTML = STAR_SVG(favorites.has(p.id));
        renderChips();
      }
    });
    const input = row.querySelector("[data-price]");
    const slot = row.querySelector(".sp-chip-slot");
    const field = bindAmdInput(input, () => {
      const n = field.get();
      edits.set(p.id, n);
      slot.innerHTML = n != null ? priceDiffChipHtml(n, silverOf(p)) : "";
      row.classList.toggle("is-dirty", isDirty(p));
      updateBar();
    });
  }

  function paintList(list) {
    listEl.innerHTML = list.length ? list.map(rowHtml).join("") : `<p class="empty-state">${emptyText()}</p>`;
    listEl.querySelectorAll("[data-product-id]").forEach((row) => wireRow(row, byId.get(Number(row.dataset.productId))));
  }
  function emptyText() {
    if (searchQuery.trim()) return t("no_products_found");
    if (view.chip === "fav") return t("oc_no_favorites");
    if (view.chip === "special") return t("sp_none_yet");
    return t("no_products_found");
  }
  function render() {
    renderChips();
    const base = baseList();
    renderCategories(base);
    paintList(view.category ? base.filter((p) => productCategory(p) === view.category) : base);
    updateBar();
  }

  // ---- Cancel / Reset / Submit ------------------------------------------------------------------------------------------
  const dirtyProducts = () => products.filter(isDirty);
  function updateBar() {
    const n = dirtyProducts().length;
    bar.hidden = n === 0;
    $("#sp-count").textContent = t("sp_changed_n").replace("{n}", String(n));
  }
  $("#sp-cancel").addEventListener("click", () => {
    edits.clear();
    render();
  });
  $("#sp-reset").addEventListener("click", () => {
    // every price of the whole list to the Silver price (still needs Submit)
    for (const p of products) {
      const silver = silverOf(p);
      if (silver > 0) edits.set(p.id, silver);
    }
    render();
    showToast(t("sp_reset_done"));
  });
  $("#sp-submit").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const changed = dirtyProducts();
    if (!changed.length) return;
    btn.disabled = true;
    try {
      const prices = changed.map((p) => {
        const now = edits.get(p.id);
        return { product_id: p.id, price_amd: now == null || now === goldList(p) ? null : now };
      });
      const result = await api.saveCustomerProductPrices(customerId, prices);
      special.clear();
      for (const r of result) special.set(r.product_id, Number(r.price_amd));
      edits.clear();
      showToast(t("sp_saved"));
      render();
    } catch (err) {
      showToast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  searchInput.addEventListener(
    "input",
    debounce(() => {
      searchQuery = searchInput.value;
      render();
    }, 150)
  );

  render();
  (async () => {
    const [fav, freq, ever] = await Promise.all([loadFavorites(), loadFrequentIds(), api.getOrderedProductIds(customerId).catch(() => [])]);
    favorites = fav;
    frequentIds = freq;
    everOrdered = ever;
    if (view.chip === "frequent" && !frequentList().length) view.chip = special.size ? "special" : brands[0] ?? "fav";
    render();
  })();
}
