import { api } from "../api.js";
import { escapeHtml, formatAmd, tierBadgeHtml, activateDialog, activateCombobox } from "../util.js";
import { t } from "../i18n.js";
import { enqueueOrder } from "../offlineQueue.js";
import { canAssignErpCustomerId } from "../state.js";

// Reps often open "Create order" several times a visit (once per checkin);
// the catalog rarely changes minute to minute, so cache it in module scope
// (persists for the app session) instead of refetching on every open. Order
// pricing is still snapshotted server-side from the live catalog at save
// time (see buildOrderLines in orders.js), so a stale cached price here is
// cosmetic only -- it never lets a rep submit an order at an outdated price.
let catalogCache = null;
let catalogCacheAt = 0;
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

async function getCatalog() {
  if (catalogCache && Date.now() - catalogCacheAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache;
  }
  catalogCache = await api.listProducts();
  catalogCacheAt = Date.now();
  return catalogCache;
}

function filterCatalog(list, query) {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((p) => [p.name, p.sku, p.brand, p.family].some((v) => v && v.toLowerCase().includes(q)));
}

// Brands the sales team actually leads with go first; anything else (a
// brand only the ERP catalog knows about) still shows up, just after.
const BRAND_PRIORITY = ["Castrol", "Lotos", "Royal"];

function sortedBrands(products) {
  const brands = [...new Set(products.map((p) => p.brand).filter(Boolean))];
  return brands.sort((a, b) => {
    const pa = BRAND_PRIORITY.indexOf(a);
    const pb = BRAND_PRIORITY.indexOf(b);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    return a.localeCompare(b);
  });
}

// Matches the taxonomy sync_field_visits.py assigns on the Castrol side
// (Edge/Magnatec/GTX/Vecton-CRB/Transmission oils/Other) plus Lotos/Royal's
// simpler Engine oils/Transmission oils/Other -- ordered the way the
// business actually leads with its lines, not alphabetically.
const FAMILY_PRIORITY = ["Edge", "Magnatec", "GTX", "Vecton/CRB", "Engine oils", "Transmission oils", "Other"];

// A broader grouping than family, for the category filter -- everything
// is "Engine oil" except the recognized transmission family, per the
// simple split requested until a real category taxonomy exists.
function productCategory(product) {
  return product.family === "Transmission oils" ? "Transmission" : "Engine oil";
}

// e.g. "Edge 5W-30" or "GTX 5w30" -> [5, 30]; null if the name doesn't
// carry a viscosity grade (a non-oil line, or an unrecognized format).
function viscosityGrade(name) {
  const m = /\b(\d{1,2})w-?(\d{1,2})\b/i.exec(name || "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// "1L" -> 1, "208L" -> 208; null for a unit that isn't a plain liter size.
function sizeLiters(unit) {
  const m = /^([\d.]+)\s*L$/i.exec((unit || "").trim());
  return m ? parseFloat(m[1]) : null;
}

// Groups by family (in the business's own order), then by viscosity grade
// low-to-high within a family, then by size ascending within the same
// variant (1L, 4L, 5L, 208L, ...) -- e.g. Edge 0w20, 0w20, 0w30, ...
// 5w30, 5w40, 10w60, each with its sizes smallest-first, instead of a
// flat alphabetical list that scatters "Edge 0w30 1L" and "Edge 0w30 4L"
// away from each other by whatever else starts with the same letters.
function sortProducts(products) {
  return [...products].sort((a, b) => {
    const fa = FAMILY_PRIORITY.indexOf(a.family ?? "Other");
    const fb = FAMILY_PRIORITY.indexOf(b.family ?? "Other");
    if (fa !== fb) return (fa === -1 ? 99 : fa) - (fb === -1 ? 99 : fb);

    const va = viscosityGrade(a.name);
    const vb = viscosityGrade(b.name);
    if (va && vb) {
      if (va[0] !== vb[0]) return va[0] - vb[0];
      if (va[1] !== vb[1]) return va[1] - vb[1];
    } else if (va || vb) {
      return va ? -1 : 1;
    }

    const nameDiff = a.name.localeCompare(b.name);
    if (nameDiff) return nameDiff;

    const sa = sizeLiters(a.unit);
    const sb = sizeLiters(b.unit);
    if (sa !== null && sb !== null) return sa - sb;
    return 0;
  });
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

function numOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Bronze/potential/competitor customers all pay the bronze (standard)
// price -- a potential or competitor account isn't a Silver/Gold
// relationship yet, so it never gets a discounted or special price.
function tierPrice(product, tier) {
  const bronze = numOrNull(product.bronze_price_amd) ?? Number(product.unit_price_amd);
  if (tier === "silver") return numOrNull(product.silver_price_amd) ?? bronze;
  if (tier === "gold") return numOrNull(product.gold_price_amd) ?? bronze;
  return bronze;
}

// null/undefined stock_qty means the catalog doesn't track stock for this
// product (e.g. a manually added line) -- no warning, not "unavailable".
function stockWarning(product, requestedQty) {
  const stock = product.stock_qty;
  if (stock === null || stock === undefined) return null;
  if (stock <= 0) return { level: "danger", text: t("out_of_stock") };
  if (requestedQty > stock) return { level: "warning", text: `${t("only_n_available_prefix")}${stock}${t("only_n_available_suffix")}` };
  return null;
}

export async function renderOrderCreate(root, navigate, customerId, checkinId) {
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

  // Keyed by product id (or a synthetic "custom-N" id for a free-text line
  // not in the catalog) so both kinds of line share the same cart map --
  // and persists across brand/family navigation so a rep can pick items
  // from several brands/families into one order.
  const cart = new Map();
  let customLineSeq = 0;

  // Brand -> flat product list -- no extra family step, just pick a brand
  // and see everything under it. A non-empty search query bypasses even
  // that, showing a flat filtered list across every brand. category narrows
  // further within that (engine oil vs transmission); showAll turns off the
  // default out-of-stock hiding so a manager can still see (and order) a
  // product that's temporarily at 0 on hand.
  const nav = { brand: null, category: null };
  let searchQuery = "";
  let showAll = false;

  container.innerHTML = `
    <div class="detail-header">
      <button class="icon-btn" id="back-btn" aria-label="${t("cancel")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-title">
        <h1>${t("create_order")}</h1>
        <span class="badge badge-neutral">${escapeHtml(customer.name)}</span>
        ${tierBadgeHtml(tier)}
      </div>
    </div>

    <div class="order-search-row">
      <input type="search" id="product-search" placeholder="${t("search_products_placeholder")}" aria-label="${t("search_products_placeholder")}" />
    </div>
    <div class="order-crumb-row" id="order-crumb-row" hidden></div>
    <div class="order-filter-row" id="order-filter-row" hidden></div>
    <div class="order-product-list" id="order-product-list"></div>
    <button type="button" class="btn btn-block" id="add-custom-line-btn">${t("add_custom_item")}</button>

    <p class="form-error" id="order-error" hidden></p>

    <div class="order-cart-bar" id="order-cart-bar" hidden>
      <div class="order-discount-row">
        <label for="order-discount-input">${t("discount_pct_label")}</label>
        <input type="number" id="order-discount-input" min="0" step="1" value="0" inputmode="numeric" />
        <div class="segmented" id="order-discount-type">
          <button type="button" class="chip chip-active" data-type="pct">${t("discount_type_pct")}</button>
          <button type="button" class="chip" data-type="amd">${t("discount_type_amd")}</button>
        </div>
      </div>
      <div class="order-cart-bar-row">
        <div class="order-cart-summary">
          <span id="order-cart-count"></span>
          <strong id="order-cart-total"></strong>
        </div>
        <button type="button" class="btn btn-primary" id="save-order-btn">${t("save_order")}</button>
      </div>
    </div>
  `;

  const backBtn = container.querySelector("#back-btn");
  backBtn.addEventListener("click", () => {
    if (searchQuery) {
      searchQuery = "";
      searchInput.value = "";
      render();
      return;
    }
    if (nav.brand !== null) {
      nav.brand = null;
      render();
      return;
    }
    navigate(`#/customers/${customerId}`);
  });

  const crumbRow = container.querySelector("#order-crumb-row");
  const filterRow = container.querySelector("#order-filter-row");
  const listEl = container.querySelector("#order-product-list");
  const searchInput = container.querySelector("#product-search");
  const cartBar = container.querySelector("#order-cart-bar");
  const cartCount = container.querySelector("#order-cart-count");
  const cartTotal = container.querySelector("#order-cart-total");
  const discountInput = container.querySelector("#order-discount-input");
  const discountTypeRow = container.querySelector("#order-discount-type");
  const errorEl = container.querySelector("#order-error");
  const saveBtn = container.querySelector("#save-order-btn");

  // A rep negotiating "5,000 off" doesn't want to convert that to a percent
  // by hand -- the two are mutually exclusive per order, same as the
  // server enforces (see discount_amd in routes/orders.js).
  let discountType = "pct";

  function discountValue() {
    const n = Number(discountInput.value);
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

  function updateCartBar() {
    const count = [...cart.values()].reduce((sum, l) => sum + l.quantity, 0);
    if (!count) {
      cartBar.hidden = true;
      return;
    }
    cartBar.hidden = false;
    cartCount.textContent = `${count} ${count === 1 ? t("item") : t("items")}`;
    cartTotal.textContent = formatAmd(cartTotalAmd());
  }

  discountInput.addEventListener("input", updateCartBar);
  discountTypeRow.querySelectorAll("[data-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      discountType = btn.dataset.type;
      discountTypeRow.querySelectorAll("[data-type]").forEach((b) => b.classList.toggle("chip-active", b === btn));
      discountInput.max = discountType === "pct" ? "100" : "";
      updateCartBar();
    });
  });

  function renderCrumbs() {
    crumbRow.hidden = !nav.brand;
    if (!nav.brand) return;
    crumbRow.innerHTML = `
      <span>${escapeHtml(nav.brand)}</span>
      <button type="button" class="btn-link" id="order-switch-brand-btn">${t("switch_brand")}</button>
    `;
    crumbRow.querySelector("#order-switch-brand-btn").addEventListener("click", () => {
      nav.brand = null;
      render();
    });
  }

  function renderFilters() {
    // Only meaningful once there's an actual product list on screen (a
    // specific brand, or a search) -- the brand-picker itself has nothing
    // to filter yet.
    filterRow.hidden = !nav.brand && !searchQuery;
    if (filterRow.hidden) return;

    const categories = [
      { value: null, label: t("category_all") },
      { value: "Engine oil", label: t("category_engine_oil") },
      { value: "Transmission", label: t("category_transmission") },
    ];
    filterRow.innerHTML = `
      <div class="segmented order-category-chips">
        ${categories
          .map(
            (c) =>
              `<button type="button" class="chip ${nav.category === c.value ? "chip-active" : ""}" data-category="${c.value ?? ""}">${escapeHtml(c.label)}</button>`
          )
          .join("")}
      </div>
      <button type="button" class="chip order-availability-toggle ${showAll ? "" : "chip-active"}" id="order-availability-toggle">
        ${showAll ? t("show_all_products") : t("available_only")}
      </button>
    `;
    filterRow.querySelectorAll("[data-category]").forEach((btn) => {
      btn.addEventListener("click", () => {
        nav.category = btn.dataset.category || null;
        render();
      });
    });
    filterRow.querySelector("#order-availability-toggle").addEventListener("click", () => {
      showAll = !showAll;
      render();
    });
  }

  function applyFilters(list) {
    let filtered = list;
    if (nav.category) filtered = filtered.filter((p) => productCategory(p) === nav.category);
    if (!showAll) filtered = filtered.filter((p) => isAvailable(p) || cart.has(p.id));
    return filtered;
  }

  function renderChipRow(items, onPick, labelFor = (x) => x) {
    listEl.innerHTML = `<div class="segmented order-chip-grid">${items
      .map((item) => `<button type="button" class="chip" data-value="${escapeHtml(String(item))}">${escapeHtml(labelFor(item))}</button>`)
      .join("")}</div>`;
    listEl.querySelectorAll("[data-value]").forEach((btn, i) => {
      btn.addEventListener("click", () => onPick(items[i]));
    });
  }

  function renderProductRow(product) {
    const line = cart.get(product.id);
    const qty = line?.quantity ?? 0;
    const price = tierPrice(product, tier);
    const warning = stockWarning(product, qty || defaultQtyForUnit(product.unit));
    const outOfStock = product.stock_qty !== null && product.stock_qty !== undefined && product.stock_qty <= 0;
    return `
      <div class="order-product-row" data-product-id="${product.id}">
        <div class="order-product-info">
          <strong>${escapeHtml(product.name)}</strong>
          <span class="muted">${[product.brand, product.unit].filter(Boolean).map(escapeHtml).join(" · ")} ${formatAmd(price)}</span>
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

  function wireRow(row, product) {
    row.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const line = cart.get(product.id) ?? {
          product_id: product.id,
          product_name: product.name,
          unit_price_amd: tierPrice(product, tier),
          quantity: 0,
        };
        if (btn.dataset.action === "add") line.quantity += defaultQtyForUnit(product.unit);
        else if (btn.dataset.action === "inc") line.quantity += 1;
        else line.quantity -= 1;

        if (line.quantity <= 0) cart.delete(product.id);
        else cart.set(product.id, line);

        row.outerHTML = renderProductRow(product);
        wireRow(listEl.querySelector(`[data-product-id="${product.id}"]`), product);
        updateCartBar();
      });
    });
  }

  function paintProductList(list) {
    listEl.innerHTML = list.length
      ? list.map(renderProductRow).join("")
      : `<p class="empty-state">${t("no_products_found")}</p>`;

    listEl.querySelectorAll("[data-product-id]").forEach((row) => {
      const product = list.find((p) => p.id === Number(row.dataset.productId));
      wireRow(row, product);
    });
  }

  function render() {
    renderCrumbs();
    renderFilters();

    if (searchQuery) {
      paintProductList(sortProducts(applyFilters(filterCatalog(products, searchQuery))));
      return;
    }

    if (!nav.brand) {
      renderChipRow(sortedBrands(products), (brand) => {
        nav.brand = brand;
        render();
      });
      return;
    }

    const brandProducts = applyFilters(products.filter((p) => p.brand === nav.brand));
    paintProductList(sortProducts(brandProducts));
  }

  render();

  searchInput.addEventListener("input", () => {
    searchQuery = searchInput.value;
    render();
  });

  container.querySelector("#add-custom-line-btn").addEventListener("click", () => {
    const name = prompt(t("custom_item_name_prompt"));
    if (!name) return;
    const priceStr = prompt(t("custom_item_price_prompt"));
    const price = Number(priceStr);
    if (!Number.isFinite(price) || price <= 0) {
      alert(t("custom_item_invalid_price"));
      return;
    }
    const id = `custom-${customLineSeq++}`;
    cart.set(id, { product_id: null, product_name: name, unit_price_amd: price, quantity: 1 });
    updateCartBar();
    alert(`${t("added")}: ${name} (${formatAmd(price)})`);
  });

  saveBtn.addEventListener("click", async () => {
    if (!cart.size) return;
    errorEl.hidden = true;
    saveBtn.disabled = true;
    saveBtn.textContent = t("saving");
    const items = [...cart.values()].map((l) => ({
      product_id: l.product_id,
      product_name: l.product_name,
      unit_price_amd: l.unit_price_amd,
      quantity: l.quantity,
    }));
    const value = discountValue();
    const discountPctToSend = discountType === "pct" ? value : 0;
    const discountAmdToSend = discountType === "amd" ? value : 0;
    try {
      const order = await api.createOrder({
        customer_id: Number(customerId),
        checkin_id: checkinId ? Number(checkinId) : undefined,
        items,
        discount_pct: discountPctToSend,
        discount_amd: discountAmdToSend,
      });
      showOrderSaved(order);
    } catch (err) {
      if (err instanceof TypeError) {
        // Offline / network failure -- queue it instead of losing the order.
        enqueueOrder({
          customerId: Number(customerId),
          checkinId: checkinId ? Number(checkinId) : undefined,
          items,
          discount_pct: discountPctToSend,
          discount_amd: discountAmdToSend,
        });
        showOrderQueued();
      } else {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
        saveBtn.disabled = false;
        saveBtn.textContent = t("save_order");
      }
    }
  });

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
