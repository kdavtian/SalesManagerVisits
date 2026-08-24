import { api } from "../api.js";
import { escapeHtml, formatAmd } from "../util.js";
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
  return list.filter((p) => [p.name, p.sku, p.brand].some((v) => v && v.toLowerCase().includes(q)));
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

  // Keyed by product id (or a synthetic "custom-N" id for a free-text line
  // not in the catalog) so both kinds of line share the same cart map.
  const cart = new Map();
  let customLineSeq = 0;

  container.innerHTML = `
    <div class="detail-header">
      <button class="icon-btn" id="back-btn" aria-label="${t("cancel")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
      </button>
      <div class="detail-header-title">
        <h1>${t("create_order")}</h1>
        <span class="badge badge-neutral">${escapeHtml(customer.name)}</span>
      </div>
    </div>

    <div class="order-search-row">
      <input type="search" id="product-search" placeholder="${t("search_products_placeholder")}" />
    </div>
    <div class="order-product-list" id="order-product-list"></div>
    <button type="button" class="btn btn-block" id="add-custom-line-btn">${t("add_custom_item")}</button>

    <p class="form-error" id="order-error" hidden></p>

    <div class="order-cart-bar" id="order-cart-bar" hidden>
      <div class="order-cart-summary">
        <span id="order-cart-count"></span>
        <strong id="order-cart-total"></strong>
      </div>
      <button type="button" class="btn btn-primary" id="save-order-btn">${t("save_order")}</button>
    </div>
  `;

  container.querySelector("#back-btn").addEventListener("click", () => {
    navigate(`#/customers/${customerId}`);
  });

  const listEl = container.querySelector("#order-product-list");
  const searchInput = container.querySelector("#product-search");
  const cartBar = container.querySelector("#order-cart-bar");
  const cartCount = container.querySelector("#order-cart-count");
  const cartTotal = container.querySelector("#order-cart-total");
  const errorEl = container.querySelector("#order-error");
  const saveBtn = container.querySelector("#save-order-btn");

  function cartTotalAmd() {
    let total = 0;
    for (const line of cart.values()) total += line.unit_price_amd * line.quantity;
    return total;
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

  function renderProductRow(product) {
    const line = cart.get(product.id);
    const qty = line?.quantity ?? 0;
    return `
      <div class="order-product-row" data-product-id="${product.id}">
        <div class="order-product-info">
          <strong>${escapeHtml(product.name)}</strong>
          <span class="muted">${[product.brand, product.unit].filter(Boolean).map(escapeHtml).join(" · ")} ${formatAmd(Number(product.unit_price_amd))}</span>
        </div>
        ${
          qty > 0
            ? `<div class="order-qty-stepper">
                <button type="button" class="icon-btn" data-action="dec" aria-label="${t("decrease")}">&minus;</button>
                <span>${qty}</span>
                <button type="button" class="icon-btn" data-action="inc" aria-label="${t("increase")}">&plus;</button>
              </div>`
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
          unit_price_amd: Number(product.unit_price_amd),
          quantity: 0,
        };
        if (btn.dataset.action === "add" || btn.dataset.action === "inc") line.quantity += 1;
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

  paintProductList(products);

  searchInput.addEventListener("input", () => {
    paintProductList(filterCatalog(products, searchInput.value));
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
    try {
      const order = await api.createOrder({
        customer_id: Number(customerId),
        checkin_id: checkinId ? Number(checkinId) : undefined,
        items,
      });
      showOrderSaved(order);
    } catch (err) {
      if (err instanceof TypeError) {
        // Offline / network failure -- queue it instead of losing the order.
        enqueueOrder({ customerId: Number(customerId), checkinId: checkinId ? Number(checkinId) : undefined, items });
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
