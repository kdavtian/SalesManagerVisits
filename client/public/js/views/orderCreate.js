import { api } from "../api.js";
import { escapeHtml, formatAmd, tierBadgeHtml } from "../util.js";
import { t } from "../i18n.js";
import { enqueueOrder } from "../offlineQueue.js";

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
  // that, showing a flat filtered list across every brand.
  const nav = { brand: null };
  let searchQuery = "";

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
    <div class="order-product-list" id="order-product-list"></div>
    <button type="button" class="btn btn-block" id="add-custom-line-btn">${t("add_custom_item")}</button>

    <p class="form-error" id="order-error" hidden></p>

    <div class="order-cart-bar" id="order-cart-bar" hidden>
      <div class="order-discount-row">
        <label for="order-discount-input">${t("discount_pct_label")}</label>
        <input type="number" id="order-discount-input" min="0" max="100" step="1" value="0" inputmode="numeric" />
        <span>%</span>
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
  const listEl = container.querySelector("#order-product-list");
  const searchInput = container.querySelector("#product-search");
  const cartBar = container.querySelector("#order-cart-bar");
  const cartCount = container.querySelector("#order-cart-count");
  const cartTotal = container.querySelector("#order-cart-total");
  const discountInput = container.querySelector("#order-discount-input");
  const errorEl = container.querySelector("#order-error");
  const saveBtn = container.querySelector("#save-order-btn");

  function discountPct() {
    const n = Number(discountInput.value);
    return Number.isFinite(n) && n > 0 ? Math.min(100, n) : 0;
  }

  function cartSubtotalAmd() {
    let total = 0;
    for (const line of cart.values()) total += line.unit_price_amd * line.quantity;
    return total;
  }

  function cartTotalAmd() {
    return cartSubtotalAmd() * (1 - discountPct() / 100);
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

  function renderCrumbs() {
    crumbRow.hidden = !nav.brand;
    crumbRow.textContent = nav.brand ? escapeHtml(nav.brand) : "";
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

    if (searchQuery) {
      paintProductList(filterCatalog(products, searchQuery));
      return;
    }

    if (!nav.brand) {
      renderChipRow(sortedBrands(products), (brand) => {
        nav.brand = brand;
        render();
      });
      return;
    }

    const brandProducts = products
      .filter((p) => p.brand === nav.brand)
      .sort((a, b) => a.name.localeCompare(b.name));
    paintProductList(brandProducts);
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
    const discount = discountPct();
    try {
      const order = await api.createOrder({
        customer_id: Number(customerId),
        checkin_id: checkinId ? Number(checkinId) : undefined,
        items,
        discount_pct: discount,
      });
      showOrderSaved(order);
    } catch (err) {
      if (err instanceof TypeError) {
        // Offline / network failure -- queue it instead of losing the order.
        enqueueOrder({ customerId: Number(customerId), checkinId: checkinId ? Number(checkinId) : undefined, items, discount_pct: discount });
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
