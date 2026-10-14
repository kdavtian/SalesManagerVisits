import { api } from "../api.js";
import { escapeHtml, formatAmd, formatPriceOrFree, tierBadgeHtml, activateDialog, activateCombobox, formatDateDMY, openInfoPopup, showToast } from "../util.js";
import { t } from "../i18n.js";
import { enqueueOrder } from "../offlineQueue.js";
import { canAssignErpCustomerId, state } from "../state.js";
import { compareProducts, sortedBrands } from "../productSort.js";
import { getProductCatalog } from "../productCatalog.js";
import { searchProducts, debounce } from "../productSearch.js";
import { numOrNull, tierPrice } from "../productPricing.js";
import { loadReorderProfile, reorderRhythmText } from "../reorder.js";
import { loadFavorites, setFavorite, loadFrequentIds } from "../productFavorites.js";

// Reps often open "Create order" several times a visit (once per checkin);
// the catalog rarely changes minute to minute, so this reads from the
// shared, IndexedDB-persisted catalog cache (productCatalog.js) instead of
// refetching every open -- persisted rather than just module-scope means it
// also survives a full app restart and works the first time offline, not
// only for the rest of one session. Order pricing is still snapshotted
// server-side from the live catalog at save time (see buildOrderLines in
// orders.js), so a stale cached price here is cosmetic only -- it never
// lets a rep submit an order at an outdated price.
async function getCatalog() {
  return getProductCatalog();
}

function filterCatalog(list, query) {
  return searchProducts(list, query);
}

// Category filter groups, from the Product Family recorded in the workbook:
// the non-engine families are categories of their own, every other family
// (Edge, Magnatec, GTX, CRB, Vecton, ON, Engine Oil, ...) is engine oil.
const NON_ENGINE_CATEGORIES = ["Transmission", "Hydraulic", "Antifreeze", "Grease", "EV fluids", "Merch", "Other"];
// Workbook family -> category where the names differ (Castrol ON = EV fluids).
const FAMILY_TO_CATEGORY = { on: "EV fluids" };
const CATEGORY_LABEL_KEY = {
  "Engine oil": "category_engine_oil",
  Transmission: "category_transmission",
  Hydraulic: "category_hydraulic",
  Antifreeze: "category_antifreeze",
  Grease: "category_grease",
  "EV fluids": "category_ev_fluids",
  Merch: "category_merch",
  Other: "category_other",
};
function productCategory(product) {
  const family = (product.family || "").trim();
  const match = FAMILY_TO_CATEGORY[family.toLowerCase()] || NON_ENGINE_CATEGORIES.find((c) => c.toLowerCase() === family.toLowerCase());
  return match || (family.toLowerCase() === "transmission oils" ? "Transmission" : "Engine oil");
}

// Brand -> family -> viscosity grade -> size, the order a rep actually
// presents the catalog to a customer -- see productSort.js for the full
// priority lists (shared with Pricelist, Warehouse Inventory, and the
// Product Catalog admin screen).
function sortProducts(products) {
  return [...products].sort(compareProducts);
}

// null/undefined stock_qty means the catalog doesn't track stock for this
// product -- treated as available, same as stockWarning below does.
function isAvailable(product) {
  return product.stock_qty === null || product.stock_qty === undefined || Number(product.stock_qty) > 0;
}

// 1L bottles are sold by the case (4), 4L/5L jugs by the pair, anything
// larger (drums, barrels) one at a time -- matches how a rep actually
// batches a shop order instead of always starting the stepper at 1.
function defaultQtyForUnit(unit) {
  const m = /^([\d.]+)\s*L$/i.exec((unit || "").trim());
  const liters = m ? parseFloat(m[1]) : null;
  if (liters === 1) return 4;
  if (liters === 4 || liters === 5) return 2;
  return 1;
}

// null/undefined stock_qty means the catalog doesn't track stock for this
// product (e.g. a manually added line) -- no warning, not "unavailable".
function stockWarning(product, requestedQty) {
  const stock = product.stock_qty;
  if (stock === null || stock === undefined) return null;
  if (stock <= 0) return { level: "danger", text: t("out_of_stock") };
  // available = stock minus what other open orders already promised (server: available_qty)
  const available = product.available_qty ?? stock;
  if (requestedQty > available) {
    const reserved = Number(product.reserved_qty) || 0;
    const base = `${t("only_n_available_prefix")}${Math.max(available, 0)}${t("only_n_available_suffix")}`;
    return { level: "warning", text: reserved > 0 ? `${base} (${t("reserved_by_orders_prefix")}${reserved})` : base };
  }
  return null;
}

// opts.from = "erp:<order id>" | "app:<order id>" pre-fills the cart with that past order (Reorder);
// opts.usual pre-fills it with the customer's usual basket (Order usual).
//
// Layout (owner, 2026-10-14): heading + customer, debt warning, ONE scrolling chip row (favorites star, Frequent,
// brands), search, category chips, the product list with a star on every card. The lines the user added are always
// reachable: the bottom bar opens "Your order" (lines with steppers, discount, payment method, Save).
export async function renderOrderCreate(root, navigate, customerId, checkinId, opts = {}) {
  root.innerHTML = `<div class="detail-view"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  const container = root.querySelector(".detail-view");

  let customer, products;
  try {
    [customer, products] = await Promise.all([api.getCustomer(customerId), getCatalog()]);
  } catch (err) {
    container.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const tier = customer.customer_tier || "potential";
  // Gold customers can have individually negotiated prices; reviewer roles
  // (director and above) can set them from this form. The server applies
  // saved ones itself -- these are only for display and the edit input.
  const canSetPrices = tier === "gold" && ["admin", "sales_director", "ceo", "operations_director"].includes(state.user?.role);
  const individualPrices = new Map();
  if (tier === "gold") {
    try {
      for (const r of await api.getCustomerProductPrices(customerId)) individualPrices.set(r.product_id, Number(r.price_amd));
    } catch {
      /* offline -- list price shown; server still applies the saved one */
    }
  }
  const basePrice = (product) => (individualPrices.has(product.id) ? individualPrices.get(product.id) : tierPrice(product, tier));
  const catalogById = new Map(products.map((p) => [p.id, p]));

  // Keyed by product id. No product can be sold out of catalog (decision C6), so every line is a real catalog
  // product. The cart survives every chip/search change, so items can come from several brands and favorites.
  const cart = new Map();

  // Which list is showing: "fav" (starred), "frequent" (default) or a brand name. A search looks through ALL
  // products whatever the chip; category narrows whichever list is showing; showAll turns off the default
  // out-of-stock hiding so a manager can still see (and order) a product that's temporarily at 0 on hand.
  const view = { chip: "frequent", category: null };
  let searchQuery = "";
  let showAll = false;
  let favorites = new Set();
  let frequentIds = [];
  let usualProfile = null;
  let dataReady = { favorites: false, frequent: false, usual: false };
  const allReady = () => dataReady.favorites && dataReady.frequent && dataReady.usual;
  let discountType = "pct";
  let discountRaw = "0";
  let paymentMethod = customer.payment_method === "cash" ? "cash" : "invoice";

  container.innerHTML = `
    <div class="detail-header oc-header">
      <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-title oc-title">
        <h1>${t("create_order")}</h1>
        <span class="oc-customer">${escapeHtml(customer.name)} ${tierBadgeHtml(tier)}</span>
      </div>
    </div>

    <p class="order-debt-hold" id="order-debt-hold" role="status" hidden></p>
    <p class="muted order-prefill-note" id="order-prefill-note" role="status" hidden></p>

    <div class="oc-chips" id="oc-chips" role="group" aria-label="${t("oc_lists")}"></div>
    <div class="order-search-row">
      <input type="search" id="product-search" placeholder="${t("search_products_placeholder")}" aria-label="${t("search_products_placeholder")}" autocomplete="off" />
      <button type="button" class="map-filter-chip oc-avail" id="order-availability-toggle"></button>
    </div>
    <div class="oc-chips oc-chips-small" id="oc-categories" hidden></div>
    <div id="oc-list-head"></div>
    <div class="order-product-list" id="order-product-list"></div>

    <button type="button" class="order-cart-bar" id="order-cart-bar" hidden aria-label="${t("oc_review_order")}">
      <span class="order-cart-summary">
        <span id="order-cart-count"></span>
        <strong id="order-cart-total"></strong>
      </span>
      <span class="btn btn-primary oc-review-btn">${t("oc_review_order")} ›</span>
    </button>
  `;

  const holdBanner = container.querySelector("#order-debt-hold");
  const prefillNote = container.querySelector("#order-prefill-note");
  const chipsEl = container.querySelector("#oc-chips");
  const categoriesEl = container.querySelector("#oc-categories");
  const listHead = container.querySelector("#oc-list-head");
  const listEl = container.querySelector("#order-product-list");
  const searchInput = container.querySelector("#product-search");
  const availToggle = container.querySelector("#order-availability-toggle");
  const cartBar = container.querySelector("#order-cart-bar");
  const cartCount = container.querySelector("#order-cart-count");
  const cartTotal = container.querySelector("#order-cart-total");

  container.querySelector("#back-btn").addEventListener("click", () => {
    if (searchQuery) {
      searchQuery = "";
      searchInput.value = "";
      render();
      return;
    }
    navigate(`#/customers/${customerId}`);
  });

  // ---- money -------------------------------------------------------------------------------------------------------
  function discountValue() {
    const n = Number(discountRaw);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return discountType === "pct" ? Math.min(100, n) : n;
  }
  function cartSubtotalAmd() {
    let total = 0;
    for (const line of cart.values()) total += line.unit_price_amd * line.quantity;
    return total;
  }
  function cartTotalAmd() {
    const subtotal = cartSubtotalAmd();
    const value = discountValue();
    return discountType === "amd" ? Math.max(0, subtotal - value) : subtotal * (1 - value / 100);
  }

  // Credit limit (accountant/directors set it on the customer): warn before the order goes over, because it will
  // then wait for a director's approval.
  let creditStatus = null;
  function creditOverAmd() {
    const limit = creditStatus?.limit;
    if (limit == null) return 0;
    return Math.max(0, Number(creditStatus.debt_amd) + Number(creditStatus.open_orders_amd) + cartTotalAmd() - limit);
  }
  api.getCreditStatus(customerId).then((s) => {
    creditStatus = s;
    // Soft credit hold: old unpaid invoices. A warning only -- the order can still be made.
    if (s.debt_hold?.on_hold) {
      holdBanner.textContent = t("debt_hold_banner").replace("{amount}", formatAmd(s.debt_hold.overdue_amd)).replace("{days}", String(s.debt_hold.oldest_due_days));
      holdBanner.hidden = false;
    }
    updateCartBar();
  }).catch(() => {
    /* offline or not allowed to see debt: no warning, the server still checks */
  });

  // ---- cart ----------------------------------------------------------------------------------------------------------
  function addToCart(product, quantity) {
    const existing = cart.get(product.id);
    if (existing) existing.quantity += quantity;
    else cart.set(product.id, { product_id: product.id, product_name: product.name, unit_price_amd: basePrice(product), quantity });
  }
  function changeQty(product, delta) {
    const line = cart.get(product.id) ?? { product_id: product.id, product_name: product.name, unit_price_amd: basePrice(product), quantity: 0 };
    line.quantity += delta;
    if (line.quantity <= 0) cart.delete(product.id);
    else cart.set(product.id, line);
  }

  function updateCartBar() {
    const count = [...cart.values()].reduce((sum, l) => sum + l.quantity, 0);
    // The bar is a fixed bottom sheet (see .order-cart-bar); the list needs reserved padding while it shows so it
    // does not cover the last rows.
    listEl.classList.toggle("order-product-list-with-cart-bar", count > 0);
    renderChips(); // brand chips show how many lines they hold
    if (!count) {
      cartBar.hidden = true;
      return;
    }
    cartBar.hidden = false;
    cartCount.textContent = `${count} ${count === 1 ? t("item") : t("items")}`;
    cartTotal.textContent = formatAmd(cartTotalAmd());
  }

  // ---- chips ---------------------------------------------------------------------------------------------------------
  const STAR_SVG = (filled) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 17l-5.4 2.9 1.1-6.1-4.5-4.2 6.1-.8z"/></svg>`;
  const brands = sortedBrands(products);
  function cartCountForBrand(brand) {
    let n = 0;
    for (const id of cart.keys()) if (catalogById.get(id)?.brand === brand) n++;
    return n;
  }
  function renderChips() {
    const searching = Boolean(searchQuery.trim());
    const chip = (key, inner, aria) =>
      `<button type="button" class="map-filter-chip ${!searching && view.chip === key ? "chip-active" : ""}" data-chip="${escapeHtml(key)}" aria-pressed="${!searching && view.chip === key}" ${aria ? `aria-label="${escapeHtml(aria)}"` : ""}>${inner}</button>`;
    chipsEl.innerHTML =
      chip("fav", `${STAR_SVG(true)}${favorites.size ? `<span class="oc-chip-n">${favorites.size}</span>` : ""}`, t("oc_favorites")) +
      chip("frequent", escapeHtml(t("oc_frequent"))) +
      brands.map((b) => chip(b, `${escapeHtml(b)}${cartCountForBrand(b) ? `<span class="oc-chip-n oc-chip-n-cart">${cartCountForBrand(b)}</span>` : ""}`)).join("");
    chipsEl.querySelectorAll("[data-chip]").forEach((btn) =>
      btn.addEventListener("click", () => {
        view.chip = btn.dataset.chip;
        view.category = null;
        // choosing a list ends a search: the chips are the way to browse
        if (searchQuery) {
          searchQuery = "";
          searchInput.value = "";
        }
        render();
        btn.scrollIntoView({ inline: "center", block: "nearest" });
      })
    );
  }

  // ---- what the current list holds ---------------------------------------------------------------------------------
  function usualRows() {
    return (usualProfile?.items ?? []).map((item) => ({ item, product: catalogById.get(item.product_id) })).filter((x) => x.product);
  }
  // Frequent = this customer's usual products first, then what the company orders most (last 90 days).
  function frequentList() {
    const out = [];
    const seen = new Set();
    for (const { product } of usualRows()) {
      out.push(product);
      seen.add(product.id);
    }
    for (const id of frequentIds) {
      const product = catalogById.get(id);
      if (product && !seen.has(id)) {
        out.push(product);
        seen.add(id);
      }
    }
    return out;
  }
  function baseList() {
    if (searchQuery.trim()) return sortProducts(filterCatalog(products, searchQuery));
    if (view.chip === "fav") return sortProducts(products.filter((p) => favorites.has(p.id)));
    if (view.chip === "frequent") return frequentList();
    return sortProducts(products.filter((p) => p.brand === view.chip));
  }
  const usualItemOf = (productId) => usualProfile?.items?.find((i) => i.product_id === productId);

  function renderCategories(list) {
    const present = new Set(list.map(productCategory));
    const cats = ["Engine oil", ...NON_ENGINE_CATEGORIES].filter((c) => present.has(c));
    if (view.category && !present.has(view.category)) view.category = null;
    categoriesEl.hidden = cats.length < 2;
    if (cats.length < 2) {
      categoriesEl.innerHTML = "";
      return;
    }
    categoriesEl.innerHTML = [{ value: null, label: t("category_all") }, ...cats.map((c) => ({ value: c, label: t(CATEGORY_LABEL_KEY[c]) }))]
      .map((c) => `<button type="button" class="map-filter-chip ${view.category === c.value ? "chip-active" : ""}" data-category="${c.value ?? ""}" aria-pressed="${view.category === c.value}">${escapeHtml(c.label)}</button>`)
      .join("");
    categoriesEl.querySelectorAll("[data-category]").forEach((btn) =>
      btn.addEventListener("click", () => {
        view.category = btn.dataset.category || null;
        render();
      })
    );
  }

  // ---- rows ------------------------------------------------------------------------------------------------------------
  function renderProductRow(product) {
    const line = cart.get(product.id);
    const qty = line?.quantity ?? 0;
    const price = line?.unit_price_amd ?? basePrice(product);
    const warning = stockWarning(product, qty || defaultQtyForUnit(product.unit));
    const outOfStock = product.stock_qty !== null && product.stock_qty !== undefined && product.stock_qty <= 0;
    const fav = favorites.has(product.id);
    const usual = view.chip === "frequent" && !searchQuery.trim() ? usualItemOf(product.id) : null;
    return `
      <div class="order-product-row" data-product-id="${product.id}">
        <button type="button" class="oc-star ${fav ? "is-fav" : ""}" data-action="star" aria-pressed="${fav}" aria-label="${fav ? t("oc_remove_favorite") : t("oc_add_favorite")}">${STAR_SVG(fav)}</button>
        <div class="order-product-info">
          <strong>${escapeHtml(product.name)}</strong>
          <span class="muted">${[product.brand, product.unit].filter(Boolean).map(escapeHtml).join(" · ")}${usual ? ` × ${usual.quantity}` : ""} · ${formatPriceOrFree(price)}</span>
          ${usual?.due ? `<span class="order-due-tag">${t("usual_item_due")}</span>` : ""}
          ${warning ? `<span class="order-stock-warning${warning.level === "danger" ? " order-stock-danger" : ""}">${warning.text}</span>` : ""}
        </div>
        ${
          qty > 0
            ? `<div class="order-qty-stepper">
                <button type="button" class="icon-btn" data-action="dec" aria-label="${t("decrease")}">&minus;</button>
                <span>${qty}</span>
                <button type="button" class="icon-btn" data-action="inc" aria-label="${t("increase")}">&plus;</button>
              </div>`
            : outOfStock
            ? `<span class="badge badge-danger">${t("out_of_stock")}</span>`
            : `<button type="button" class="btn btn-sm" data-action="add">${t("add")}</button>`
        }
      </div>
    `;
  }

  async function toggleFavorite(product) {
    const on = !favorites.has(product.id);
    const ok = await setFavorite(favorites, product.id, on);
    if (!ok) {
      showToast(t("oc_favorite_failed"));
    } else if (on) {
      showToast(t("oc_favorite_added"));
    } else {
      showToast(t("oc_favorite_removed"), { actionLabel: t("undo"), onAction: () => toggleFavoriteTo(product, true) });
    }
    if (view.chip === "fav" && !searchQuery.trim()) render();
    else {
      rerenderRow(product);
      renderChips();
    }
  }
  async function toggleFavoriteTo(product, on) {
    if (favorites.has(product.id) === on) return;
    const ok = await setFavorite(favorites, product.id, on);
    if (!ok) showToast(t("oc_favorite_failed"));
    render();
  }

  function rerenderRow(product) {
    const row = listEl.querySelector(`[data-product-id="${product.id}"]`);
    if (!row) return;
    row.outerHTML = renderProductRow(product);
    wireRow(listEl.querySelector(`[data-product-id="${product.id}"]`), product);
  }

  function wireRow(row, product) {
    row.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        if (action === "star") {
          toggleFavorite(product);
          return;
        }
        if (action === "add") changeQty(product, defaultQtyForUnit(product.unit));
        else changeQty(product, action === "inc" ? 1 : -1);
        rerenderRow(product);
        updateCartBar();
      });
    });
  }

  function paintProductList(list) {
    listEl.innerHTML = list.length ? list.map(renderProductRow).join("") : "";
    listEl.querySelectorAll("[data-product-id]").forEach((row) => wireRow(row, catalogById.get(Number(row.dataset.productId))));
  }

  // The line above the list: for Frequent the one-tap "add the usual basket", and the availability toggle.
  function renderListHead(shown) {
    const searching = Boolean(searchQuery.trim());
    let left = "";
    if (searching) left = `<span class="oc-head-note muted">${t("oc_search_all").replace("{n}", String(shown.length))}</span>`;
    else if (view.chip === "frequent") {
      const addable = usualRows().filter((x) => isAvailable(x.product) && !cart.has(x.product.id));
      const note = reorderRhythmText(usualProfile?.cadence);
      if (addable.length > 1) {
        left = `<button type="button" class="btn btn-sm" id="order-usual-add-all">${t("usual_order_add_all").replace("{n}", String(addable.length))}</button>${
          note ? `<button type="button" class="settings-hint-icon" id="order-usual-info" aria-label="${t("more_info")}">!</button>` : ""
        }`;
      }
    }
    listHead.innerHTML = left ? `<div class="oc-list-head-row"><div class="oc-list-head-left">${left}</div></div>` : "";
    listHead.querySelector("#order-usual-add-all")?.addEventListener("click", () => {
      for (const { item, product } of usualRows()) if (isAvailable(product) && !cart.has(product.id)) addToCart(product, item.quantity);
      render();
      updateCartBar();
    });
    listHead.querySelector("#order-usual-info")?.addEventListener("click", () =>
      openInfoPopup(`<p>${escapeHtml(reorderRhythmText(usualProfile?.cadence))}</p><p class="muted">${t("usual_order_hint").replace("{n}", String(usualProfile?.orders_considered ?? 0))}</p>`)
    );
  }

  function emptyText() {
    if (searchQuery.trim()) return t("no_products_found");
    if (view.chip === "fav") return t("oc_no_favorites");
    if (view.chip === "frequent") return allReady() ? t("oc_no_frequent") : t("loading");
    return t("no_products_found");
  }

  availToggle.addEventListener("click", () => {
    showAll = !showAll;
    render();
  });

  function render() {
    renderChips();
    availToggle.classList.toggle("chip-active", !showAll);
    availToggle.setAttribute("aria-pressed", String(!showAll));
    availToggle.textContent = showAll ? t("show_all_products") : t("available_only");
    const base = baseList();
    renderCategories(base);
    let list = view.category ? base.filter((p) => productCategory(p) === view.category) : base;
    if (!showAll) list = list.filter((p) => isAvailable(p) || cart.has(p.id));
    renderListHead(list);
    paintProductList(list);
    if (!list.length) listEl.innerHTML = `<p class="empty-state">${emptyText()}</p>`;
  }

  // Favorites, the Frequent ranking and the usual basket arrive after the screen is up; nothing blocks on them.
  (async function loadShortcuts() {
    const [fav, freq, profile] = await Promise.all([
      loadFavorites().finally(() => (dataReady.favorites = true)),
      loadFrequentIds().finally(() => (dataReady.frequent = true)),
      loadReorderProfile(customerId, opts.from || null).finally(() => (dataReady.usual = true)),
    ]);
    favorites = fav;
    frequentIds = freq;
    usualProfile = profile;
    const notes = [];
    if (profile && opts.from && profile.lines) {
      let skipped = profile.lines.not_available;
      for (const line of profile.lines.lines) {
        const product = catalogById.get(line.product_id);
        if (product && isAvailable(product)) addToCart(product, line.quantity);
        else skipped++;
      }
      notes.push(t("reorder_prefilled").replace("{date}", formatDateDMY(profile.lines.date)));
      if (skipped) notes.push(t("reorder_skipped").replace("{n}", String(skipped)));
    } else if (profile && opts.usual) {
      let skipped = 0;
      for (const item of profile.items) {
        const product = catalogById.get(item.product_id);
        if (product && isAvailable(product)) addToCart(product, item.quantity);
        else skipped++;
      }
      notes.push(t("usual_order_added"));
      if (skipped) notes.push(t("reorder_skipped").replace("{n}", String(skipped)));
    }
    if (notes.length && profile.cadence.days_since_order === 0) notes.push(t("reorder_already_today"));
    if (notes.length) {
      prefillNote.textContent = notes.join(" · ");
      prefillNote.hidden = false;
    }
    // Nothing to call "frequent" (new customer, offline): open the first brand instead of an empty page.
    if (view.chip === "frequent" && !frequentList().length && brands.length) view.chip = brands[0];
    render();
    updateCartBar();
  })();

  render();
  searchInput.addEventListener(
    "input",
    debounce(() => {
      searchQuery = searchInput.value;
      render();
    }, 150)
  );

  // ---- "Your order": the lines, discount, payment method and Save ---------------------------------------------------
  cartBar.addEventListener("click", openOrderSheet);

  function openOrderSheet() {
    if (!cart.size) return;
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `<div class="sheet oc-order-sheet"></div>`;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    const sheet = overlay.querySelector(".sheet");
    const close = () => {
      overlay.remove();
      render();
      updateCartBar();
    };
    overlay.addEventListener("click", (e) => e.target === overlay && close());

    function paintSheet() {
      if (!cart.size) {
        close();
        return;
      }
      const lines = [...cart.values()];
      const over = creditOverAmd();
      sheet.innerHTML = `
        <div class="oc-sheet-head">
          <div><h2>${t("oc_your_order")}</h2><span class="muted">${escapeHtml(customer.name)}</span></div>
          <button type="button" class="icon-btn sheet-close-x" data-close aria-label="${t("close")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="oc-lines">${lines
          .map((line) => {
            const product = catalogById.get(line.product_id);
            const warning = product ? stockWarning(product, line.quantity) : null;
            return `<div class="oc-line" data-line="${line.product_id}">
              <div class="oc-line-info">
                <strong>${escapeHtml(line.product_name)}</strong>
                <span class="muted">${product ? [product.brand, product.unit].filter(Boolean).map(escapeHtml).join(" · ") + " · " : ""}${formatPriceOrFree(line.unit_price_amd)}</span>
                ${canSetPrices ? `<label class="muted">${t("custom_price")} <input type="number" min="0" step="1" inputmode="numeric" class="order-price-input" data-price-input value="${line.unit_price_amd}" style="width:6rem"></label>` : ""}
                ${warning ? `<span class="order-stock-warning${warning.level === "danger" ? " order-stock-danger" : ""}">${warning.text}</span>` : ""}
              </div>
              <div class="oc-line-side">
                <div class="order-qty-stepper">
                  <button type="button" class="icon-btn" data-dec aria-label="${t("decrease")}">&minus;</button>
                  <span>${line.quantity}</span>
                  <button type="button" class="icon-btn" data-inc aria-label="${t("increase")}">&plus;</button>
                </div>
                <strong class="oc-line-total">${formatAmd(line.unit_price_amd * line.quantity)}</strong>
              </div>
            </div>`;
          })
          .join("")}</div>
        <button type="button" class="btn btn-block oc-add-more" data-close>${t("oc_add_more")}</button>
        ${over > 0 ? `<p class="order-stock-warning oc-credit">${t("credit_over_banner_prefix")}${formatAmd(Math.round(over))}${t("credit_over_banner_suffix")}</p>` : ""}
        <div class="order-discount-row">
          <label for="order-payment-method-input">${t("order_payment_method_label")}</label>
          <select id="order-payment-method-input">
            <option value="invoice" ${paymentMethod !== "cash" ? "selected" : ""}>${t("payment_method_invoice")}</option>
            <option value="cash" ${paymentMethod === "cash" ? "selected" : ""}>${t("payment_method_cash")}</option>
          </select>
        </div>
        <div class="order-discount-row">
          <label for="order-discount-input">${t("discount_pct_label")}</label>
          <input type="number" id="order-discount-input" min="0" step="1" value="${escapeHtml(discountRaw)}" inputmode="numeric" />
          <div class="segmented" id="order-discount-type">
            <button type="button" class="chip ${discountType === "pct" ? "chip-active" : ""}" data-type="pct">${t("discount_type_pct")}</button>
            <button type="button" class="chip ${discountType === "amd" ? "chip-active" : ""}" data-type="amd">${t("discount_type_amd")}</button>
          </div>
        </div>
        <p class="form-error" id="order-error" hidden></p>
        <div class="order-cart-bar-row">
          <div class="order-cart-summary">
            <span>${lines.reduce((n, l) => n + l.quantity, 0)} ${t("items")}</span>
            <strong id="oc-sheet-total">${formatAmd(cartTotalAmd())}</strong>
          </div>
          <button type="button" class="btn btn-primary" id="save-order-btn">${t("save_order")}</button>
        </div>`;
      sheet.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
      sheet.querySelectorAll("[data-line]").forEach((row) => {
        const id = Number(row.dataset.line);
        const product = catalogById.get(id);
        row.querySelector("[data-dec]").addEventListener("click", () => {
          changeQty(product ?? { id, name: cart.get(id).product_name }, -1);
          paintSheet();
        });
        row.querySelector("[data-inc]").addEventListener("click", () => {
          changeQty(product ?? { id, name: cart.get(id).product_name }, 1);
          paintSheet();
        });
        row.querySelector("[data-price-input]")?.addEventListener("change", (e) => {
          const line = cart.get(id);
          const n = Number(e.target.value);
          if (!line || !Number.isFinite(n) || n < 0) return;
          line.unit_price_amd = n;
          line.price_override = product ? n !== basePrice(product) : true;
          paintSheet();
        });
      });
      sheet.querySelector("#order-payment-method-input").addEventListener("change", (e) => (paymentMethod = e.target.value === "cash" ? "cash" : "invoice"));
      const discountInput = sheet.querySelector("#order-discount-input");
      discountInput.addEventListener("input", () => {
        discountRaw = discountInput.value;
        sheet.querySelector("#oc-sheet-total").textContent = formatAmd(cartTotalAmd());
      });
      sheet.querySelectorAll("#order-discount-type [data-type]").forEach((btn) =>
        btn.addEventListener("click", () => {
          discountType = btn.dataset.type;
          paintSheet();
        })
      );
      sheet.querySelector("#save-order-btn").addEventListener("click", () => saveOrder(overlay, sheet));
    }
    paintSheet();
  }

  async function saveOrder(overlay, sheet) {
    if (!cart.size) return;
    const saveBtn = sheet.querySelector("#save-order-btn");
    const sheetError = sheet.querySelector("#order-error");
    sheetError.hidden = true;
    saveBtn.disabled = true;
    saveBtn.textContent = t("saving");
    const items = [...cart.values()].map((l) => ({
      product_id: l.product_id,
      product_name: l.product_name,
      unit_price_amd: l.unit_price_amd,
      quantity: l.quantity,
      ...(l.price_override ? { price_override: true } : {}),
    }));
    const value = discountValue();
    const discountPctToSend = discountType === "pct" ? value : 0;
    const discountAmdToSend = discountType === "amd" ? value : 0;
    // Generated once, before the first (online) attempt -- reused as-is if this falls through to enqueueOrder
    // below, so a retry after a lost response can't create a second order. See server/src/routes/orders.js
    // and offlineQueue.js.
    const clientRef = crypto.randomUUID();
    try {
      const order = await api.createOrder({
        customer_id: Number(customerId),
        checkin_id: checkinId ? Number(checkinId) : undefined,
        items,
        discount_pct: discountPctToSend,
        discount_amd: discountAmdToSend,
        payment_method: paymentMethod,
        client_ref: clientRef,
      });
      overlay.remove();
      showOrderSaved(order);
    } catch (err) {
      if (err instanceof TypeError) {
        // Offline / network failure -- queue it instead of losing the order.
        enqueueOrder({
          clientRef,
          customerId: Number(customerId),
          customerName: customer.name,
          totalAmd: cartTotalAmd(),
          checkinId: checkinId ? Number(checkinId) : undefined,
          items,
          discount_pct: discountPctToSend,
          discount_amd: discountAmdToSend,
          payment_method: paymentMethod,
        });
        overlay.remove();
        showOrderQueued();
      } else {
        sheetError.textContent = err.message;
        sheetError.hidden = false;
        saveBtn.disabled = false;
        saveBtn.textContent = t("save_order");
      }
    }
  }

  function showOrderSaved(order) {
    if (order.status === "draft") {
      openErpRequiredSheet(order);
      return;
    }
    container.innerHTML = `
      <div class="checkin-result result-success">
        <div class="result-icon">✓</div>
        <h2>${t("order_saved")}</h2>
        <p>${escapeHtml(customer.name)} · ${formatAmd(Number(order.total_amd))}</p>
        ${order.approval_status === "pending" ? `<p class="muted">${t("discount_pending_approval")}</p>` : ""}
        <button class="btn btn-primary btn-block" id="order-done-btn">${t("done")}</button>
      </div>
    `;
    container.querySelector("#order-done-btn").addEventListener("click", () => {
      navigate(`#/customers/${customerId}`);
    });
  }

  // An order for a customer with no ERP customer ID lands as a draft (see
  // POST /orders) -- ask for the ID right away so it can go straight to
  // "submitted" without the rep needing to remember to come back to it
  // later. Closing without an ID is a valid choice too: the order is
  // already safely saved as a draft either way.
  function openErpRequiredSheet(order) {
    container.innerHTML = `
      <div class="checkin-result result-warning">
        <div class="result-icon">📝</div>
        <h2>${t("order_saved_as_draft")}</h2>
        <p>${escapeHtml(customer.name)} · ${formatAmd(Number(order.total_amd))}</p>
        <p class="muted">${t("draft_needs_erp_id")}</p>
        <button class="btn btn-primary btn-block" id="draft-done-btn">${t("done")}</button>
      </div>
    `;
    container.querySelector("#draft-done-btn").addEventListener("click", () => {
      navigate(`#/customers/${customerId}`);
    });

    if (!canAssignErpCustomerId(customer)) return;

    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("erp_customer_id")}</h2>
        <p class="muted">${t("draft_needs_erp_id")}</p>
        <form id="submit-order-form">
          <label class="erp-suggest-wrap">${t("erp_customer_id")}
            <input type="text" name="erp_customer_id" id="draft-erp-input" autocomplete="off" />
            <div class="erp-suggest-list" id="draft-erp-suggest-list" hidden></div>
          </label>
          <p class="form-error" id="draft-erp-error" hidden></p>
          <div class="sheet-actions">
            <button type="button" class="btn" id="draft-close-btn">${t("save_as_draft")}</button>
            <button type="submit" class="btn btn-primary">${t("submit_order")}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);

    function close() {
      overlay.remove();
    }
    overlay.querySelector("#draft-close-btn").addEventListener("click", close);
    overlay.addEventListener("click", (e) => e.target === overlay && close());

    const erpInput = overlay.querySelector("#draft-erp-input");
    const suggestList = overlay.querySelector("#draft-erp-suggest-list");
    let erpOptions = [];
    api
      .getUnlinkedErpCustomers()
      .then((results) => {
        erpOptions = [...results].sort((a, b) =>
          (a.customer_name || "").localeCompare(b.customer_name || "", undefined, { sensitivity: "base" })
        );
      })
      .catch(() => {});

    function renderSuggestions(query) {
      const q = query.trim().toLowerCase();
      const matches = q
        ? erpOptions.filter((r) => (r.customer_name || "").toLowerCase().includes(q) || r.erp_customer_id.includes(q))
        : erpOptions;
      if (!matches.length) {
        suggestList.hidden = true;
        suggestList.innerHTML = "";
        return;
      }
      suggestList.innerHTML = matches
        .slice(0, 30)
        .map(
          (r) => `
        <div class="erp-suggest-item" data-id="${escapeHtml(r.erp_customer_id)}">
          <span>${escapeHtml(r.customer_name || r.erp_customer_id)}</span>
          ${r.debt_amd > 0 ? `<span class="muted">${formatAmd(r.debt_amd)}</span>` : ""}
        </div>`
        )
        .join("");
      suggestList.hidden = false;
    }

    erpInput.addEventListener("focus", () => renderSuggestions(erpInput.value));
    erpInput.addEventListener("input", () => renderSuggestions(erpInput.value));
    erpInput.addEventListener("blur", () => {
      setTimeout(() => (suggestList.hidden = true), 150);
    });
    activateCombobox(erpInput, suggestList, (item) => {
      erpInput.value = item.dataset.id;
    });

    const form = overlay.querySelector("#submit-order-form");
    const errorEl = overlay.querySelector("#draft-erp-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submitBtn = form.querySelector('button[type="submit"]');
      const erpId = erpInput.value.trim();
      if (!erpId) {
        errorEl.textContent = t("erp_customer_id_required");
        errorEl.hidden = false;
        return;
      }
      submitBtn.disabled = true;
      try {
        await api.submitOrder(order.id, erpId);
        close();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
  }

  function showOrderQueued() {
    container.innerHTML = `
      <div class="checkin-result result-warning">
        <div class="result-icon">⇪</div>
        <h2>${t("youre_offline")}</h2>
        <p>${t("offline_queued_message")}</p>
        <button class="btn btn-primary btn-block" id="order-done-btn">${t("done")}</button>
      </div>
    `;
    container.querySelector("#order-done-btn").addEventListener("click", () => {
      navigate(`#/customers/${customerId}`);
    });
  }
}
