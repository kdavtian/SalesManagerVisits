import { api } from "../api.js";
import { escapeHtml, formatAmd, groupDigits, bindAmdInput, formatPriceOrFree, tierBadgeHtml, activateDialog, activateCombobox, formatDateDMY, openInfoPopup } from "../util.js";
import { packQty, packStepUp, packStepDown, bindStepperButton } from "../stepper.js";
import { t } from "../i18n.js";
import { enqueueOrder } from "../offlineQueue.js";
import { openSyncQueueSheet } from "../syncQueueSheet.js";
import { openPrintBlankSheet } from "../orderBlankPrint.js";
import { icons } from "../icons.js";
import { canAssignErpCustomerId, state } from "../state.js";
import { compareProducts, sortedBrands } from "../productSort.js";
import { getProductCatalog } from "../productCatalog.js";
import { searchProducts, debounce } from "../productSearch.js";
import { tierPrice } from "../productPricing.js";
import { loadReorderProfile, reorderRhythmText } from "../reorder.js";
import { loadFrequentIds } from "../productFrequent.js";
import { openWishSheet } from "../wishSheet.js";
import { NON_ENGINE_CATEGORIES, CATEGORY_LABEL_KEY, productCategory, isAvailable, priceDiffChipHtml } from "../productBrowse.js";

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

// Brand -> family -> viscosity grade -> size, the order a rep actually
// presents the catalog to a customer -- see productSort.js for the full
// priority lists (shared with Pricelist, Warehouse Inventory, and the
// Product Catalog admin screen).
function sortProducts(products) {
  return [...products].sort(compareProducts);
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
// Layout (owner, 2026-10-14): heading + customer, debt warning, ONE scrolling chip row (Frequent, brands, Merch),
// search, category chips, the product list. The lines the user added are always
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
  // Gold customer's special price: a chip with the difference to the Silver price (Customer settings -> Special pricelist)
  const specialChip = (product, price) => (tier === "gold" && individualPrices.has(product.id) ? priceDiffChipHtml(price, tierPrice(product, "silver")) : "");

  // Keyed by product id. No product can be sold out of catalog (decision C6), so every line is a real catalog
  // product. The cart survives every chip/search change, so items can come from several brands.
  const cart = new Map();
  // Catalog products this customer already wished for (last 60 days, not back yet): their row says "Wished" instead of "Wish".
  const wishedIds = new Set();

  // Which list is showing: "frequent" (default), a brand name or Merch. A search looks through ALL
  // products whatever the chip; category narrows whichever list is showing; showAll turns off the default
  // out-of-stock hiding so a manager can still see (and order) a product that's temporarily at 0 on hand.
  const view = { chip: "frequent", category: null };
  let searchQuery = "";
  // "Available only" (Yes by default). Frequent lists everything the customer ever ordered, so it starts with the
  // switch OFF; leaving Frequent puts it back to Yes. The user can flip it either way.
  let showAll = true;
  let frequentIds = []; // company-wide most ordered: only the fallback for a customer with no history
  let everOrdered = []; // [{ product_id, times }] this customer's whole history
  let usualProfile = null;
  let dataReady = { frequent: false, usual: false };
  const allReady = () => dataReady.frequent && dataReady.usual;
  let discountType = "amd";
  let discountAmount = 0; // the number typed in the discount field (AMD or %)
  let paymentMethod = customer.payment_method === "cash" ? "cash" : "invoice";
  // "Payment due" is asked for both methods and starts at the customer's own credit term (Customer settings, 45 by
  // default) whichever method is tapped; the rep can type another number (0 = on delivery is allowed for cash).
  let paymentTermDays = Number(customer.credit_term_days) > 0 ? Number(customer.credit_term_days) : 45;
  // Downpayment: 30 % on a new customer's first order, 15 % after that (GET /customers/:id/order-defaults); the rep
  // can change the number or switch it to AMD. dpTouched stops the late-arriving default from overwriting an edit.
  let dpType = "pct";
  let dpValue = 15;
  let dpTouched = false;
  let dueTouched = false;
  let methodTouched = false;
  let floorBelow = false; // last answer of the price-floor check, kept across repaints so the warning never blinks
  let firstOrder = null; // null until the defaults arrive
  let sheetRepaint = null;

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

    ${customer.counterfeit_flag ? `<p class="pl-warn-banner" role="alert">${t("pl_counterfeit_warning")}</p>` : ""}
    <p class="order-debt-hold" id="order-debt-hold" role="status" hidden></p>
    <p class="muted order-prefill-note" id="order-prefill-note" role="status" hidden></p>

    <div class="oc-chips" id="oc-chips" role="group" aria-label="${t("oc_lists")}"></div>
    <div class="order-search-row oc-searchbar">
      <input type="search" id="product-search" placeholder="${t("search_products_placeholder")}" aria-label="${t("search_products_placeholder")}" autocomplete="off" />
      <span class="oc-avail-label" id="oc-avail-label">${t("oc_available_only")}</span>
      <button type="button" class="toggle-switch" id="order-availability-toggle" role="switch" aria-checked="false" aria-labelledby="oc-avail-label"><span class="toggle-thumb"></span></button>
    </div>
    <div class="oc-chips oc-chips-small" id="oc-categories" hidden></div>
    <div id="oc-list-head"></div>
    <div class="order-product-list" id="order-product-list"></div>

    <div class="order-cart-bar" id="order-cart-bar" hidden>
      <div class="order-cart-summary">
        <span id="order-cart-count"></span>
        <span class="oc-total-line"><strong id="order-cart-total"></strong><button type="button" class="settings-hint-icon" id="oc-bar-info" aria-label="${t("more_info")}">!</button></span>
      </div>
      <span class="btn btn-primary oc-review-btn">${t("oc_review_order")} ›</span>
    </div>
  `;

  // Effort measurement (migration 124): where the order started, seconds from opening this screen to Save, and taps. Two
  // numbers kept in memory and sent with the order: no extra request, no timers.
  const startedAt = Date.now();
  let taps = 0;
  container.addEventListener("click", () => taps++);
  const orderMetrics = () => {
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    return { source: opts.usual ? "usual" : opts.from ? "repeat" : "new", ...(seconds <= 1800 ? { seconds } : {}), taps };
  };

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
    const n = Number(discountAmount);
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

  api.listWishes(customerId).then((rows) => {
    for (const w of rows) {
      if (!w.product_id || w.back_in_stock_at || wishedIds.has(w.product_id)) continue;
      wishedIds.add(w.product_id);
      const product = catalogById.get(w.product_id);
      if (product) rerenderRow(product);
    }
  }).catch(() => {
    /* offline: rows offer "Wish" again; a second wish is harmless */
  });

  api.getOrderDefaults(customerId).then((d) => {
    if (Number(d.credit_term_days) > 0 && !dueTouched && d.last_terms?.payment_term_days == null) paymentTermDays = Number(d.credit_term_days);
    firstOrder = Boolean(d.first_order);
    // The last order's terms win over the generic defaults (and over the customer's setting): same method, same due
    // days, same downpayment %, so a regular customer's order needs no typing at all.
    const last = d.last_terms;
    if (last && !methodTouched) paymentMethod = last.payment_method === "cash" ? "cash" : "invoice";
    if (last?.payment_term_days != null && !dueTouched) paymentTermDays = Number(last.payment_term_days);
    if (!dpTouched) dpValue = last?.downpayment_pct != null && dpType === "pct" ? Number(last.downpayment_pct) : Number(d.downpayment_pct) || 0;
    sheetRepaint?.();
  }).catch(() => {
    /* offline: the repeat-customer default (15 %) stays; the rep can change it */
  });

  // Press feedback for the stepper buttons: the row/sheet is repainted on every tap, so the CSS :active state of the old
  // button is gone at once. The new button flashes and the number pops so the tap is always seen.
  function flashStepper(btn, qtyEl) {
    btn?.classList.add("is-flash");
    qtyEl?.classList.add("qty-pop");
  }

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
  // Merch (Castrol Stend and other give-aways) is its own chip at the end, not part of the Castrol brand.
  const MERCH = "__merch__";
  const isMerch = (p) => productCategory(p) === "Merch";
  const brands = sortedBrands(products.filter((p) => !isMerch(p)));
  const chipKeys = products.some(isMerch) ? [...brands, MERCH] : brands;
  const chipProducts = (key) => products.filter((p) => (key === MERCH ? isMerch(p) : p.brand === key && !isMerch(p)));
  function cartCountForChip(key) {
    let n = 0;
    for (const id of cart.keys()) {
      const p = catalogById.get(id);
      if (p && (key === MERCH ? isMerch(p) : p.brand === key && !isMerch(p))) n++;
    }
    return n;
  }
  function renderChips() {
    const searching = Boolean(searchQuery.trim());
    const chip = (key, inner, aria) =>
      `<button type="button" class="map-filter-chip ${!searching && view.chip === key ? "chip-active" : ""}" data-chip="${escapeHtml(key)}" aria-pressed="${!searching && view.chip === key}" ${aria ? `aria-label="${escapeHtml(aria)}"` : ""}>${inner}</button>`;
    chipsEl.innerHTML =
      chip("frequent", escapeHtml(t("oc_frequent"))) +
      chipKeys.map((k) => chip(k, `${escapeHtml(k === MERCH ? t("category_merch") : k)}${cartCountForChip(k) ? `<span class="oc-chip-n oc-chip-n-cart">${cartCountForChip(k)}</span>` : ""}`)).join("");
    chipsEl.querySelectorAll("[data-chip]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const leavingFrequent = view.chip === "frequent" && btn.dataset.chip !== "frequent";
        const enteringFrequent = view.chip !== "frequent" && btn.dataset.chip === "frequent";
        view.chip = btn.dataset.chip;
        view.category = null;
        // Frequent shows everything ever ordered, so "Available only" goes OFF there and back ON elsewhere
        if (enteringFrequent) showAll = true;
        else if (leavingFrequent) showAll = false;
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
  // Frequent = every product this customer has EVER ordered, from all brands: the usual basket first (its typical
  // quantity is shown), then by how many orders they appeared in. A customer with no history gets the company's most
  // ordered products instead, so the list is never empty for a new shop.
  function frequentList() {
    const out = [];
    const seen = new Set();
    const push = (product) => {
      if (product && !seen.has(product.id)) {
        out.push(product);
        seen.add(product.id);
      }
    };
    for (const { product } of usualRows()) push(product);
    for (const r of everOrdered) push(catalogById.get(r.product_id));
    if (!out.length) for (const id of frequentIds) push(catalogById.get(id));
    return out;
  }
  function baseList() {
    if (searchQuery.trim()) return sortProducts(filterCatalog(products, searchQuery));
    if (view.chip === "frequent") return frequentList();
    return sortProducts(chipProducts(view.chip));
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
  // The brand is written on a row only where nothing above it already names it: under a brand header or a brand chip it is noise
  // (and it pushed the size off the line). Set by paintProductList.
  let brandInRows = false;
  function renderProductRow(product) {
    const line = cart.get(product.id);
    const qty = line?.quantity ?? 0;
    const price = line?.unit_price_amd ?? basePrice(product);
    const warning = stockWarning(product, qty || defaultQtyForUnit(product.unit));
    const outOfStock = product.stock_qty !== null && product.stock_qty !== undefined && product.stock_qty <= 0;
    const usual = view.chip === "frequent" && !searchQuery.trim() ? usualItemOf(product.id) : null;
    // Two lines: the name, then brand / size on the left and the price on the right. The Add button or stepper
    // sits alone on the right, so the price never crowds it.
    return `
      <div class="order-product-row" data-product-id="${product.id}">
        <div class="order-product-info">
          <strong>${escapeHtml(product.name)}</strong>
          <span class="oc-meta-line">
            <span class="muted oc-meta-text">${[brandInRows ? product.brand : null, product.unit].filter(Boolean).map(escapeHtml).join(" · ")}${usual ? ` × ${usual.quantity}` : ""}</span>
            <span class="oc-price-line">${specialChip(product, price)}<span class="oc-price">${formatPriceOrFree(price)}</span></span>
          </span>
          ${usual?.due ? `<span class="order-due-tag">${t("usual_item_due")}</span>` : ""}
          ${warning && !outOfStock ? `<span class="order-stock-warning">${warning.text}</span>` : ""}
        </div>
        <div class="oc-row-side">
          ${
            qty > 0
              ? `<div class="order-qty-stepper">
                  <button type="button" class="icon-btn" data-action="dec" aria-label="${t("decrease")}">&minus;</button>
                  <span>${qty}</span>
                  <button type="button" class="icon-btn" data-action="inc" aria-label="${t("increase")}">&plus;</button>
                </div>`
              : outOfStock
              ? wishedIds.has(product.id)
                ? `<span class="badge oc-wished" title="${escapeHtml(t("out_of_stock"))}">${t("wish_wished")}</span>`
                : `<button type="button" class="btn btn-sm oc-wish-btn" data-action="wish" aria-label="${escapeHtml(`${t("out_of_stock")}: ${t("wish_btn")}`)}">${t("wish_btn")}</button>`
              : `<button type="button" class="btn btn-sm" data-action="add">${t("add")}</button>`
          }
        </div>
      </div>
    `;
  }

  function rerenderRow(product, action) {
    const row = listEl.querySelector(`[data-product-id="${product.id}"]`);
    if (!row) return;
    row.outerHTML = renderProductRow(product);
    const fresh = listEl.querySelector(`[data-product-id="${product.id}"]`);
    wireRow(fresh, product);
    if (action) flashStepper(fresh.querySelector(`[data-action="${action === "add" ? "inc" : action}"]`), fresh.querySelector(".order-qty-stepper span"));
  }

  // Long press on + / - moves by one pack (see stepper.js); a tap by 1.
  function setQty(product, qty) {
    const line = cart.get(product.id);
    const current = line?.quantity ?? 0;
    changeQty(product, qty - current);
  }
  function wireRow(row, product) {
    const pack = packQty(product.unit);
    row.querySelectorAll("[data-action]").forEach((btn) => {
      const action = btn.dataset.action;
      const after = () => {
        rerenderRow(product, action);
        updateCartBar();
      };
      if (action === "wish") {
        btn.addEventListener("click", async () => {
          if (await openWishSheet({ customerId, product })) {
            wishedIds.add(product.id);
            rerenderRow(product);
          }
        });
        return;
      }
      if (action === "inc" || action === "dec") {
        bindStepperButton(btn, {
          onTap: () => {
            changeQty(product, action === "inc" ? 1 : -1);
            after();
          },
          onHold: () => {
            const current = cart.get(product.id)?.quantity ?? 0;
            setQty(product, action === "inc" ? packStepUp(current, pack) : packStepDown(current, pack));
            after();
          },
        });
        return;
      }
      btn.addEventListener("click", () => {
        changeQty(product, defaultQtyForUnit(product.unit));
        after();
      });
    });
  }

  // grouped = Frequent and search results: brand headers, each brand sorted in the catalog order (a single brand chip is
  // already one group, so it needs no headers).
  function paintProductList(list, grouped) {
    if (grouped && list.length) {
      const groups = brandGroups(list.map((product) => ({ product, name: product.name })));
      brandInRows = groups.length === 1;
      listEl.innerHTML = groups
        .map((g) => `${groups.length > 1 ? `<div class="oc-list-group">${escapeHtml(g.label)}</div>` : ""}${g.rows.map((r) => renderProductRow(r.product)).join("")}`)
        .join("");
    } else {
      brandInRows = view.chip === "special"; // the Special chip mixes brands; a brand chip is one brand
      listEl.innerHTML = list.length ? list.map(renderProductRow).join("") : "";
    }
    listEl.querySelectorAll("[data-product-id]").forEach((row) => wireRow(row, catalogById.get(Number(row.dataset.productId))));
  }

  // The line above the list: for Frequent the one-tap "add the usual basket", and the availability toggle.
  function renderListHead(shown) {
    const searching = Boolean(searchQuery.trim());
    let left = "";
    if (searching) left = `<span class="oc-head-note muted">${t("oc_search_all").replace("{n}", String(shown.length))}</span>${newWishButton()}`;
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
    wireNewWish(listHead);
    listHead.querySelector("#order-usual-add-all")?.addEventListener("click", () => {
      for (const { item, product } of usualRows()) if (isAvailable(product) && !cart.has(product.id)) addToCart(product, item.quantity);
      render();
      updateCartBar();
    });
    listHead.querySelector("#order-usual-info")?.addEventListener("click", () =>
      openInfoPopup(`<p>${escapeHtml(reorderRhythmText(usualProfile?.cadence))}</p><p class="muted">${t("usual_order_hint").replace("{n}", String(usualProfile?.orders_considered ?? 0))}</p>`)
    );
  }

  // "Product we don't have": a product we never carried, written down as a wish (starts with what the rep searched for).
  function newWishButton() {
    return `<button type="button" class="btn btn-sm oc-wish-new" data-wish-new>${t("wish_new_btn")}</button>`;
  }
  function wireNewWish(scope) {
    scope.querySelector("[data-wish-new]")?.addEventListener("click", () => openWishSheet({ customerId, name: searchInput.value.trim() }));
  }

  function emptyText() {
    if (searchQuery.trim()) return t("no_products_found");
    if (view.chip === "frequent") return allReady() ? t("oc_no_frequent") : t("loading");
    return t("no_products_found");
  }

  availToggle.addEventListener("click", () => {
    showAll = !showAll;
    render();
  });

  function render() {
    renderChips();
    availToggle.setAttribute("aria-checked", String(!showAll)); // ON = "Available only: Yes"
    const base = baseList();
    renderCategories(base);
    let list = view.category ? base.filter((p) => productCategory(p) === view.category) : base;
    // "Available only" hides what is out of stock while browsing; a search still shows it, because the rep looked for it by
    // name: it cannot be added, only wished for ("Wish" on the row).
    if (!showAll && !searchQuery.trim()) list = list.filter((p) => isAvailable(p) || cart.has(p.id));
    renderListHead(list);
    paintProductList(list, view.chip === "frequent" || Boolean(searchQuery.trim()));
    if (!list.length) listEl.innerHTML = `<p class="empty-state">${emptyText()}</p>`;
  }

  // The Frequent ranking and the usual basket arrive after the screen is up; nothing blocks on them.
  (async function loadShortcuts() {
    const [freq, profile, ever] = await Promise.all([
      loadFrequentIds().finally(() => (dataReady.frequent = true)),
      loadReorderProfile(customerId, opts.from || null).finally(() => (dataReady.usual = true)),
      api.getOrderedProductIds(customerId).catch(() => []),
    ]);
    frequentIds = freq;
    usualProfile = profile;
    everOrdered = ever;
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
    } else if (opts.from && !profile?.lines) {
      notes.push(t("reorder_none"));
    } else if (profile && opts.usual) {
      let skipped = 0;
      for (const item of profile.items) {
        const product = catalogById.get(item.product_id);
        if (product && isAvailable(product)) addToCart(product, item.quantity);
        else skipped++;
      }
      notes.push(profile.items.length ? t("usual_order_added") : t("usual_order_none"));
      if (skipped) notes.push(t("reorder_skipped").replace("{n}", String(skipped)));
    } else if (opts.usual) {
      notes.push(t("usual_order_none"));
    }
    if (notes.length && profile?.cadence.days_since_order === 0) notes.push(t("reorder_already_today"));
    if (notes.length) {
      prefillNote.textContent = notes.join(" · ");
      prefillNote.hidden = false;
    }
    // Nothing to call "frequent" (new customer, offline): open the first brand instead of an empty page.
    if (view.chip === "frequent" && !frequentList().length && brands.length) {
      view.chip = brands[0];
      showAll = false;
    }
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
  cartBar.querySelector("#oc-bar-info").addEventListener("click", (e) => {
    e.stopPropagation();
    openTierComparison();
  });

  // "!" next to the total: what this order would cost on each price list, so the rep (and the customer) can see
  // how much the customer's tier saves, and what another tier would change. Before discount. A role that cannot see
  // the gold list (sales managers) simply gets no gold row.
  function openTierComparison() {
    const lines = [...cart.values()].map((l) => ({ line: l, product: catalogById.get(l.product_id) })).filter((x) => x.product);
    if (!lines.length) return;
    const current = cartSubtotalAmd();
    const total = (priceOf) => lines.reduce((sum, { line, product }) => sum + priceOf(product) * line.quantity, 0);
    const hasGold = lines.every(({ product }) => Number(product.gold_price_amd) > 0);
    const retail = total((p) => Number(p.effective_retail_amd ?? p.retail_price_amd) || tierPrice(p, "bronze"));
    const rows = [
      { key: "retail", label: t("price_retail"), amount: retail },
      { key: "bronze", label: t("tier_bronze"), amount: total((p) => tierPrice(p, "bronze")) },
      { key: "silver", label: t("tier_silver"), amount: total((p) => tierPrice(p, "silver")) },
      ...(hasGold ? [{ key: "gold", label: t("tier_gold"), amount: total((p) => tierPrice(p, "gold")) }] : []),
    ];
    const customerTierKey = tier === "silver" || tier === "gold" ? tier : "bronze";
    const hasSpecial = lines.some(({ product }) => individualPrices.has(product.id));
    const signed = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${groupDigits(Math.abs(n))}`;
    const saved = Math.round(retail - current);
    openInfoPopup(`
      <h3 class="oc-tier-title">${t("oc_tier_title")}</h3>
      <p class="muted">${t("oc_tier_note")}</p>
      <table class="oc-tier-table">
        <thead><tr><th></th><th>${t("oc_tier_total")}</th><th>${t("oc_tier_diff")}</th></tr></thead>
        <tbody>
          ${rows
            .map((r) => {
              const diff = Math.round(r.amount - current);
              const mine = r.key === customerTierKey && !hasSpecial;
              return `<tr class="${mine ? "is-mine" : ""}"><td>${escapeHtml(r.label)}${mine ? ` <span class="oc-tier-mine">${t("oc_tier_this")}</span>` : ""}</td><td>${groupDigits(r.amount)}</td><td class="${diff < 0 ? "oc-tier-less" : diff > 0 ? "oc-tier-more" : ""}">${diff === 0 ? "—" : signed(diff)}</td></tr>`;
            })
            .join("")}
        </tbody>
      </table>
      <p><strong>${t("oc_tier_this_order")}: ${groupDigits(current)} ${t("amd")}</strong>${hasSpecial ? ` <span class="muted">(${t("oc_tier_special")})</span>` : ""}</p>
      ${saved > 0 ? `<p class="oc-tier-less">${t("oc_tier_saved_vs_retail").replace("{amount}", formatAmd(saved))}</p>` : ""}
      <p class="muted">${t("oc_tier_diff_hint")}</p>`);
  }

  // Entries ({ product, ...}) grouped by brand -- Castrol, Lotos, Orlen, Royal, other brands A-Z, then Merch, then anything
  // without a catalog product -- each group in the canonical catalog order (productSort.js), the order the rep walks the
  // customer through the pricelist. Used by the cart sheet and the Frequent / search lists.
  function brandGroups(entries) {
    const groups = new Map();
    for (const entry of entries) {
      const product = entry.product;
      const key = !product ? "" : productCategory(product) === "Merch" ? MERCH : product.brand || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    const order = [...sortedBrands([...groups.keys()].filter((k) => k && k !== MERCH).map((brand) => ({ brand }))), ...(groups.has(MERCH) ? [MERCH] : []), ...(groups.has("") ? [""] : [])];
    return order.map((key) => ({
      key,
      label: key === MERCH ? t("category_merch") : key || "—",
      rows: groups.get(key).sort((x, y) => (x.product && y.product ? compareProducts(x.product, y.product) : (x.name || "").localeCompare(y.name || ""))),
    }));
  }
  const groupedCartLines = () => brandGroups([...cart.values()].map((line) => ({ line, product: catalogById.get(line.product_id) ?? null, name: line.product_name })));

  // Downpayment (advance) in AMD, on the total after the discount.
  function downpaymentAmd() {
    const v = Number(dpValue);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return dpType === "pct" ? Math.round((cartTotalAmd() * Math.min(100, v)) / 100) : Math.round(v);
  }
  const dueDays = () => paymentTermDays;
  const dueValid = () => Number.isInteger(dueDays()) && dueDays() >= (paymentMethod === "cash" ? 0 : 1) && dueDays() <= 365;

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
      sheetRepaint = null;
      render();
      updateCartBar();
    };
    overlay.addEventListener("click", (e) => e.target === overlay && close());
    overlay.addEventListener("click", () => taps++);

    let floorSeq = 0;
    // flash = { id, action } -- the stepper button just pressed gets a short highlight and the new number a pop, because
    // the whole sheet is repainted and the finger-down state of the old button is gone with it.
    function paintSheet(flash) {
      if (!cart.size) {
        close();
        return;
      }
      const over = creditOverAmd();
      const itemCount = [...cart.values()].reduce((n, l) => n + l.quantity, 0);
      const lineHtml = ({ line, product }) => {
        const warning = product ? stockWarning(product, line.quantity) : null;
        return `<div class="oc-line" data-line="${line.product_id}">
            <div class="oc-line-info">
              <strong>${escapeHtml(line.product_name)}</strong>
              <span class="oc-meta-line">
                <span class="muted oc-meta-text">${product?.unit ? escapeHtml(product.unit) : ""}</span>
                <span class="oc-price-line">${product ? specialChip(product, line.unit_price_amd) : ""}${canSetPrices ? `<input class="order-price-input amd-input oc-price-input" data-price-input inputmode="numeric" aria-label="${t("custom_price")}" value="${groupDigits(line.unit_price_amd)}">` : `<span class="oc-price">${formatPriceOrFree(line.unit_price_amd)}</span>`}<strong class="oc-line-total">${formatAmd(line.unit_price_amd * line.quantity)}</strong></span>
              </span>
              ${warning ? `<span class="order-stock-warning${warning.level === "danger" ? " order-stock-danger" : ""}">${warning.text}</span>` : ""}
            </div>
            <div class="order-qty-stepper">
              <button type="button" class="icon-btn" data-dec aria-label="${t("decrease")}">&minus;</button>
              <span>${line.quantity}</span>
              <button type="button" class="icon-btn" data-inc aria-label="${t("increase")}">&plus;</button>
            </div>
          </div>`;
      };
      const unit = (type) => (type === "pct" ? "%" : t("amd"));
      const keepScroll = sheet.querySelector(".oc-sheet-scroll")?.scrollTop ?? 0;
      sheet.innerHTML = `
        <div class="oc-sheet-scroll">
        <div class="oc-sheet-head">
          <div><h2>${t("oc_your_order")}</h2><span class="muted">${escapeHtml(customer.name)}</span></div>
          <button type="button" class="icon-btn sheet-close-x" data-close aria-label="${t("close")}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="oc-lines">${groupedCartLines()
          .map(
            (g) => `<div class="oc-group"><div class="oc-group-head"><span>${escapeHtml(g.label)}</span><span>${formatAmd(g.rows.reduce((s, r) => s + r.line.unit_price_amd * r.line.quantity, 0))}</span></div>${g.rows.map(lineHtml).join("")}</div>`
          )
          .join("")}</div>
        <button type="button" class="btn btn-block oc-add-more" data-close>${t("oc_add_more")}</button>
        <p class="order-stock-warning order-stock-danger oc-floor" id="oc-floor"${floorBelow ? "" : " hidden"}>${t("oc_floor_warning")}</p>
        ${over > 0 ? `<p class="order-stock-warning oc-credit">${t("credit_over_banner_prefix")}${formatAmd(Math.round(over))}${t("credit_over_banner_suffix")}</p>` : ""}
        <div class="oc-terms">
          <div class="oc-terms-row">
            <span class="oc-terms-label">${t("order_payment_method_label")}</span>
            <div class="oc-seg oc-seg-wide" id="oc-method">
              <button type="button" class="${paymentMethod === "cash" ? "is-on" : ""}" data-method="cash">${t("payment_method_cash")}</button>
              <button type="button" class="${paymentMethod === "invoice" ? "is-on" : ""}" data-method="invoice">${t("payment_method_invoice")}</button>
            </div>
          </div>
          <div class="oc-terms-row">
            <label class="oc-terms-label" for="oc-due-days">${t("oc_payment_due")}</label>
            <span class="oc-due"><input id="oc-due-days" class="oc-field oc-field-days" inputmode="numeric" value="${dueDays()}" /> <span class="muted" id="oc-due-unit"></span></span>
          </div>
          <div class="oc-terms-row">
            <label class="oc-terms-label" for="order-discount-input">${t("discount_pct_label")}</label>
            <input id="order-discount-input" class="oc-field" placeholder="0" aria-label="${t("discount_pct_label")} (${unit(discountType)})" />
            <div class="oc-seg" id="order-discount-type">
              <button type="button" class="${discountType === "amd" ? "is-on" : ""}" data-type="amd">${t("discount_type_amd")}</button>
              <button type="button" class="${discountType === "pct" ? "is-on" : ""}" data-type="pct">${t("discount_type_pct")}</button>
            </div>
          </div>
          <div class="oc-terms-row">
            <label class="oc-terms-label" for="oc-dp-input">${t("oc_downpayment")}${firstOrder === null ? "" : `<small>${t(firstOrder ? "oc_dp_first" : "oc_dp_repeat")}</small>`}</label>
            <input id="oc-dp-input" class="oc-field" placeholder="0" aria-label="${t("oc_downpayment")} (${unit(dpType)})" />
            <div class="oc-seg" id="oc-dp-type">
              <button type="button" class="${dpType === "amd" ? "is-on" : ""}" data-type="amd">${t("discount_type_amd")}</button>
              <button type="button" class="${dpType === "pct" ? "is-on" : ""}" data-type="pct">${t("discount_type_pct")}</button>
            </div>
          </div>
          <p class="oc-dp-summary" id="oc-dp-summary"></p>
        </div>
        </div>
        <div class="oc-sheet-foot">
          <p class="form-error" id="order-error" hidden></p>
          <div class="oc-sheet-foot-row">
            <div class="order-cart-summary">
              <span class="oc-total-line"><strong id="oc-sheet-total">${formatAmd(cartTotalAmd())}</strong><button type="button" class="settings-hint-icon" data-tier-info aria-label="${t("more_info")}">!</button></span>
              <span class="muted oc-foot-sub">${itemCount} ${t("items")}</span>
            </div>
            <button type="button" class="btn btn-primary" id="save-order-btn">${t("save_order")}</button>
          </div>
        </div>`;
      sheet.querySelector(".oc-sheet-scroll").scrollTop = keepScroll;
      sheetRepaint = paintSheet;
      sheet.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
      sheet.querySelector("[data-tier-info]").addEventListener("click", openTierComparison);
      sheet.querySelectorAll("[data-line]").forEach((row) => {
        const id = Number(row.dataset.line);
        const product = catalogById.get(id) ?? { id, name: cart.get(id).product_name, unit: "" };
        const pack = packQty(product.unit);
        const stepTo = (qty, action) => {
          changeQty(product, qty - (cart.get(id)?.quantity ?? 0));
          paintSheet({ id, action });
        };
        bindStepperButton(row.querySelector("[data-dec]"), {
          onTap: () => stepTo((cart.get(id)?.quantity ?? 0) - 1, "dec"),
          onHold: () => stepTo(packStepDown(cart.get(id)?.quantity ?? 0, pack), "dec"),
        });
        bindStepperButton(row.querySelector("[data-inc]"), {
          onTap: () => stepTo((cart.get(id)?.quantity ?? 0) + 1, "inc"),
          onHold: () => stepTo(packStepUp(cart.get(id)?.quantity ?? 0, pack), "inc"),
        });
        const priceInput = row.querySelector("[data-price-input]");
        if (priceInput) {
          const amd = bindAmdInput(priceInput);
          priceInput.addEventListener("change", () => {
            const line = cart.get(id);
            const n = amd.get();
            if (!line || n == null || n < 0) return;
            line.unit_price_amd = n;
            line.price_override = catalogById.get(id) ? n !== basePrice(catalogById.get(id)) : true;
            paintSheet();
          });
        }
      });
      if (flash) {
        const row = sheet.querySelector(`[data-line="${flash.id}"]`);
        flashStepper(row?.querySelector(flash.action === "inc" ? "[data-inc]" : "[data-dec]"), row?.querySelector(".order-qty-stepper span"));
      }

      // Price floor preview: is a line below landing cost (needs the CEO / an admin)? Asked from the server, which
      // never returns a cost. Debounced; a stale answer is dropped.
      let floorTimer = null;
      const checkFloor = () => {
        clearTimeout(floorTimer);
        const seq = ++floorSeq;
        floorTimer = setTimeout(async () => {
          const el = sheet.querySelector("#oc-floor");
          if (!el || !cart.size) return;
          const value = discountValue();
          try {
            const res = await api.priceCheckOrder({
              customer_id: Number(customerId),
              items: [...cart.values()].map((l) => ({ product_id: l.product_id, quantity: l.quantity, unit_price_amd: l.unit_price_amd, ...(l.price_override ? { price_override: true } : {}) })),
              discount_pct: discountType === "pct" ? value : 0,
              discount_amd: discountType === "amd" ? value : 0,
            });
            if (seq !== floorSeq) return;
            floorBelow = Boolean(res.below_landing);
            el.hidden = !floorBelow;
          } catch {
            /* offline or not allowed: no preview, the server still decides when the order is saved */
          }
        }, 350);
      };
      // Everything that depends on the typed numbers: the total, the due-days hint, the downpayment line.
      const refreshTotals = () => {
        const total = cartTotalAmd();
        sheet.querySelector("#oc-sheet-total").textContent = formatAmd(total);
        const down = Math.min(downpaymentAmd(), Math.round(total));
        const dpSummary = sheet.querySelector("#oc-dp-summary");
        const tooMuch = downpaymentAmd() > Math.round(total);
        dpSummary.classList.toggle("is-error", tooMuch);
        dpSummary.textContent = tooMuch
          ? t("oc_downpayment_invalid")
          : `${t("oc_down_short")} ${formatAmd(down)} · ${t("oc_left_short")} ${formatAmd(Math.round(total) - down)}`;
        sheet.querySelector("#oc-due-unit").textContent = paymentMethod === "cash" && paymentTermDays === 0 ? t("oc_due_on_delivery") : t("oc_days_unit");
        checkFloor();
      };
      // A money-or-percent field (discount, downpayment): AMD with thousands separators, or a % up to 100.
      const bindValueField = (input, type, get, set) => {
        if (type === "amd") {
          const amd = bindAmdInput(input, () => {
            set(amd.get() ?? 0);
            refreshTotals();
          });
          amd.set(get() || null);
          return;
        }
        input.inputMode = "decimal";
        input.classList.add("amd-input");
        input.value = get() ? String(get()) : "";
        input.addEventListener("input", () => {
          set(Math.min(100, Math.max(0, Number(input.value.replace(",", ".")) || 0)));
          refreshTotals();
        });
      };
      bindValueField(sheet.querySelector("#order-discount-input"), discountType, () => discountAmount, (v) => (discountAmount = v));
      bindValueField(sheet.querySelector("#oc-dp-input"), dpType, () => dpValue, (v) => ((dpValue = v), (dpTouched = true)));
      refreshTotals();

      sheet.querySelectorAll("#order-discount-type [data-type]").forEach((btn) =>
        btn.addEventListener("click", () => {
          if (discountType === btn.dataset.type) return;
          discountType = btn.dataset.type;
          discountAmount = 0;
          paintSheet();
        })
      );
      // Switching the downpayment between % and AMD keeps the same money amount (30 % of 1,000,000 <-> 300,000).
      sheet.querySelectorAll("#oc-dp-type [data-type]").forEach((btn) =>
        btn.addEventListener("click", () => {
          if (dpType === btn.dataset.type) return;
          const total = cartTotalAmd();
          dpValue = dpType === "pct" ? downpaymentAmd() : total > 0 ? Math.round((downpaymentAmd() / total) * 1000) / 10 : 0;
          dpType = btn.dataset.type;
          dpTouched = true;
          paintSheet();
        })
      );
      sheet.querySelectorAll("#oc-method [data-method]").forEach((btn) =>
        btn.addEventListener("click", () => {
          paymentMethod = btn.dataset.method;
          methodTouched = true;
          paintSheet();
        })
      );
      sheet.querySelector("#oc-due-days").addEventListener("input", (e) => {
        const digits = e.target.value.replace(/\D/g, "").slice(0, 3);
        e.target.value = digits;
        paymentTermDays = digits === "" ? 0 : Number(digits);
        dueTouched = true;
        refreshTotals();
      });
      sheet.querySelector("#save-order-btn").addEventListener("click", () => saveOrder(overlay, sheet));
    }
    paintSheet();
  }

  async function saveOrder(overlay, sheet) {
    if (!cart.size) return;
    const saveBtn = sheet.querySelector("#save-order-btn");
    const sheetError = sheet.querySelector("#order-error");
    sheetError.hidden = true;
    if (!dueValid()) {
      sheetError.textContent = t("oc_due_invalid");
      sheetError.hidden = false;
      sheet.querySelector("#oc-due-days")?.focus();
      return;
    }
    if (downpaymentAmd() > Math.round(cartTotalAmd())) {
      sheetError.textContent = t("oc_downpayment_invalid");
      sheetError.hidden = false;
      return;
    }
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
    // The downpayment goes as the unit the rep typed (a % stays a % if the total changes server-side).
    const downpayment = dpType === "pct" ? { downpayment_pct: Math.min(100, Number(dpValue) || 0) } : { downpayment_amd: downpaymentAmd() };
    try {
      const order = await api.createOrder({
        customer_id: Number(customerId),
        checkin_id: checkinId ? Number(checkinId) : undefined,
        items,
        discount_pct: discountPctToSend,
        discount_amd: discountAmdToSend,
        payment_method: paymentMethod,
        payment_term_days: dueDays(),
        ...downpayment,
        metrics: orderMetrics(),
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
          payment_term_days: dueDays(),
          ...downpayment,
          metrics: orderMetrics(),
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
        <button class="btn btn-block order-share-btn" id="order-share-btn">${icons.printer}<span>${t("order_share_btn")}</span></button>
        <button class="btn btn-primary btn-block" id="order-done-btn">${t("done")}</button>
      </div>
    `;
    // The delivery-acceptance act with the payment terms: open it, save it or send it to the customer.
    container.querySelector("#order-share-btn").addEventListener("click", () => openPrintBlankSheet([{ id: order.id, order_code: order.order_code }]));
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
        <h2>${t("saved_on_phone")}</h2>
        <p>${t("queued_order_text")}</p>
        <button class="btn btn-block" id="order-queue-btn">${t("view_waiting")}</button>
        <button class="btn btn-primary btn-block" id="order-done-btn">${t("done")}</button>
      </div>
    `;
    container.querySelector("#order-queue-btn").addEventListener("click", openSyncQueueSheet);
    container.querySelector("#order-done-btn").addEventListener("click", () => {
      navigate(`#/customers/${customerId}`);
    });
  }
}
