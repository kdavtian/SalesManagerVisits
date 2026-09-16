import { api } from "../api.js";
import { escapeHtml, formatAmd, activateDialog, channelDisplayLabel, formatLiters } from "../util.js";
import { t, getLang } from "../i18n.js";
import { icons } from "../icons.js";
import { ORDER_STATUS_ICONS } from "../ordersSearchEnhancements.js";
import { loadWithCache } from "../listCache.js";
import { STATUS_META, openOrderDetailSheet } from "../orderDetailSheet.js";

const STATUS_FILTERS = ["", "draft", "submitted", "confirmed", "packed_stock_out", "delivered"];

function formatDate(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Local calendar-day key an order's created_at falls into -- grouping is by
// the viewer's own day boundary, not UTC, so an order placed at 11pm
// doesn't jump to "tomorrow" in the list.
function orderDateKey(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function formatOrderDateHeading(value) {
  const d = new Date(value);
  const month = d.toLocaleDateString(getLang() === "hy" ? "hy" : "en", { month: "short" });
  return `${d.getDate()} ${month}`;
}

export async function renderOrders(root, navigate) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="list-header-row">
        <h1>${t("orders_title")}</h1>
        <button type="button" class="icon-btn" id="orders-new-btn" aria-label="${t("create_order")}">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>
      <div class="order-status-filter-row" id="order-status-filters"></div>
      <div class="list-toolbar">
        <input type="search" id="order-search" placeholder="${t("search")}" aria-label="${t("search")}" />
        <button type="button" class="icon-btn" id="order-filter-btn" aria-label="${t("filter")}" aria-haspopup="menu" aria-expanded="false" aria-controls="order-filter-menu">${icons.filter}</button>
        <div id="order-filter-menu" class="dropdown-menu" role="menu" hidden></div>
      </div>
      <div class="card-list" id="orders-list"><p class="loading-state" role="status">${t("loading")}</p></div>
    </div>
  `;

  // Submitted is the default view -- that's the queue someone opening this
  // page almost always cares about (what still needs confirming), not the
  // full history. Mirrors Payments' own "pending by default" convention,
  // and matches what the Orders nav badge itself counts, so tapping a
  // badge showing "3" lands on exactly those 3 instead of every order.
  const DEFAULT_STATUS_FILTER = "submitted";

  const filterRow = root.querySelector("#order-status-filters");
  filterRow.innerHTML = STATUS_FILTERS.map(
    (s) => `<button class="map-filter-chip ${s === DEFAULT_STATUS_FILTER ? "chip-active" : ""}" data-status="${s}" aria-pressed="${s === DEFAULT_STATUS_FILTER ? "true" : "false"}">${s ? t(STATUS_META[s].key) : t("all_statuses")}</button>`
  ).join("");

  const listEl = root.querySelector("#orders-list");
  const searchInput = root.querySelector("#order-search");
  const filterBtn = root.querySelector("#order-filter-btn");
  const filterMenu = root.querySelector("#order-filter-menu");

  let activeStatus = DEFAULT_STATUS_FILTER;
  let channelFilter = "";
  let orders = [];
  let hasMore = false;
  let loadingMore = false;
  let searchDebounceTimer;

  function renderFilterMenu() {
    const channels = [...new Set(orders.map((o) => o.sales_channel).filter(Boolean))].sort();
    filterMenu.innerHTML = `
      <button role="menuitemradio" aria-checked="${channelFilter === ""}" data-channel="">${t("all_channels")}</button>
      ${channels
        .map((c) => `<button role="menuitemradio" aria-checked="${c === channelFilter}" data-channel="${escapeHtml(c)}">${escapeHtml(channelDisplayLabel(c))}</button>`)
        .join("")}
    `;
    filterMenu.querySelectorAll("[data-channel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        channelFilter = btn.dataset.channel;
        filterMenu.hidden = true;
        filterBtn.setAttribute("aria-expanded", "false");
        paint();
      });
    });
  }

  filterBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willShow = filterMenu.hidden;
    if (willShow) renderFilterMenu();
    filterMenu.hidden = !willShow;
    filterBtn.setAttribute("aria-expanded", String(willShow));
  });
  root.addEventListener("click", () => {
    filterMenu.hidden = true;
    filterBtn.setAttribute("aria-expanded", "false");
  });

  async function load() {
    // Stale-while-revalidate (see listCache.js): repaint from last
    // session's first page for this exact status tab immediately, then
    // swap in the live page once it lands -- pagination (loadMore below)
    // stays fully live, only the first page benefits from this.
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    let paintedOnce = false;
    try {
      const params = activeStatus ? { status: activeStatus } : {};
      await loadWithCache(
        `orders-list:${activeStatus || "all"}`,
        () => api.listOrders(params),
        (result) => {
          orders = result.rows;
          hasMore = result.has_more;
          paint();
          paintedOnce = true;
        }
      );
    } catch (err) {
      if (!paintedOnce) listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    const btn = listEl.querySelector("#orders-load-more");
    if (btn) btn.disabled = true;
    try {
      const params = activeStatus ? { status: activeStatus } : {};
      params.offset = orders.length;
      const result = await api.listOrders(params);
      orders = orders.concat(result.rows);
      hasMore = result.has_more;
    } finally {
      loadingMore = false;
    }
    paint();
  }

  function paint() {
    const search = searchInput.value.trim().toLowerCase();
    let filtered = orders;
    if (channelFilter) filtered = filtered.filter((o) => o.sales_channel === channelFilter);
    if (search) {
      filtered = filtered.filter((o) => {
        const haystack = [o.customer_name, o.order_code, o.user_name, o.sales_channel, formatDate(o.created_at)]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(search);
      });
    }

    if (!filtered.length) {
      listEl.innerHTML = `<p class="empty-state">${t("no_orders_found")}</p>`;
      return;
    }

    // Grouped by the order's own calendar day (not the whole filtered
    // list's range) -- each day's header row totals just that day's
    // orders: amount, liters (see server's total_liters, computed from
    // catalog-linked lines only), and order count.
    // Totals computed in one pass up front (a Map keyed by day) rather than
    // re-filtering the whole `filtered` array once per row it contains --
    // that was O(n²) (a full list scan for every single order), which on a
    // long history noticeably added up on typing a fresh search term.
    const dayTotals = new Map();
    for (const o of filtered) {
      const dateKey = orderDateKey(o.created_at);
      const day = dayTotals.get(dateKey) ?? { total: 0, liters: 0, count: 0 };
      day.total += Number(o.total_amd);
      day.liters += Number(o.total_liters || 0);
      day.count += 1;
      dayTotals.set(dateKey, day);
    }

    let lastDateKey = null;
    listEl.innerHTML = filtered
      .map((o) => {
        const meta = STATUS_META[o.status] ?? STATUS_META.submitted;
        const dateKey = orderDateKey(o.created_at);
        let dateHeading = "";
        if (dateKey !== lastDateKey) {
          lastDateKey = dateKey;
          const day = dayTotals.get(dateKey);
          dateHeading = `
            <div class="order-date-heading">
              <span class="order-date-heading-label">${formatOrderDateHeading(o.created_at)}</span>
              <span class="order-date-heading-stats">${formatAmd(day.total)} | ${formatLiters(day.liters)} | ${day.count} ${t("orders_count_label")}</span>
            </div>`;
        }
        return `${dateHeading}
        <button class="card list-row" data-order-id="${o.id}">
          <span class="list-row-icon list-row-icon-${meta.iconTint}" aria-hidden="true">${ORDER_STATUS_ICONS[o.status] ?? ""}</span>
          <div class="list-row-body">
            <div class="list-row-top">
              <strong>${escapeHtml(o.customer_name)}</strong>
              <span class="list-row-trailing-text text-amount">${formatAmd(Number(o.total_amd))}</span>
            </div>
            <div class="muted list-row-meta">${o.order_code ? `${escapeHtml(o.order_code)} · ` : ""}${escapeHtml(o.user_name)} · ${formatDate(o.created_at)}</div>
            <div class="list-row-bottom">
              <span class="badge ${meta.cls}">${t(meta.key)}</span>
              ${o.payment_method ? `<span class="badge badge-neutral">${t(o.payment_method === "cash" ? "payment_method_cash" : "payment_method_invoice")}</span>` : ""}
            </div>
          </div>
          <span class="chevron">&#8250;</span>
        </button>
      `;
      })
      .join("");

    // Loading more only makes sense against the unfiltered server order --
    // once a client-side search or channel filter narrows what's shown,
    // there's no "next page" of that search to fetch, only of the whole
    // list.
    if (hasMore && !search && !channelFilter) {
      listEl.insertAdjacentHTML("beforeend", `<button type="button" class="btn btn-block" id="orders-load-more">${t("load_more")}</button>`);
      listEl.querySelector("#orders-load-more").addEventListener("click", loadMore);
    }

    listEl.querySelectorAll("[data-order-id]").forEach((row) => {
      row.addEventListener("click", () => openOrderDetailSheet(Number(row.dataset.orderId), { onChanged: load, navigate }));
    });
  }

  filterRow.querySelectorAll("[data-status]").forEach((btn) => {
    btn.addEventListener("click", () => {
      filterRow.querySelectorAll("[data-status]").forEach((b) => {
        b.setAttribute("aria-pressed", "false");
        b.classList.remove("chip-active");
      });
      btn.setAttribute("aria-pressed", "true");
      btn.classList.add("chip-active");
      activeStatus = btn.dataset.status;
      load();
    });
  });
  // Debounced (300ms, same as the Customers list search) -- paint() rebuilds
  // the full order list's HTML on every call, which on a long order history
  // visibly stutters typing if it ran on every single keystroke.
  searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(paint, 300);
  });
  root.querySelector("#orders-new-btn").addEventListener("click", openCustomerPicker);

  // Orders always belong to a customer -- picking one here just forwards
  // into the same order-creation screen the customer detail page's "New
  // order" button uses, so there's one order-creation flow, not two.
  function openCustomerPicker() {
    const overlay = document.createElement("div");
    overlay.className = "sheet-overlay";
    overlay.innerHTML = `
      <div class="sheet">
        <h2>${t("select_customer")}</h2>
        <input type="search" id="order-customer-search" placeholder="${t("search_customers")}" aria-label="${t("search_customers")}" autofocus />
        <div class="card-list" id="order-customer-results" style="margin:12px 0; height:45vh; overflow-y:auto;"></div>
        <div class="sheet-actions">
          <button type="button" class="btn" id="order-customer-cancel">${t("cancel")}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    activateDialog(overlay);
    overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());
    overlay.querySelector("#order-customer-cancel").addEventListener("click", () => overlay.remove());

    const searchEl = overlay.querySelector("#order-customer-search");
    const resultsEl = overlay.querySelector("#order-customer-results");
    let searchSeq = 0;

    async function search(query) {
      const seq = ++searchSeq;
      resultsEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
      let results;
      try {
        results = await api.listCustomers(query ? { search: query } : {});
      } catch (err) {
        if (seq === searchSeq) resultsEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
        return;
      }
      if (seq !== searchSeq) return;
      if (!results.length) {
        resultsEl.innerHTML = `<p class="empty-state">${t("no_customers_found")}</p>`;
        return;
      }
      resultsEl.innerHTML = results
        .slice(0, 30)
        .map((c) => `<button type="button" class="card" style="text-align:left; width:100%;" data-customer-id="${c.id}">${escapeHtml(c.name)}</button>`)
        .join("");
      resultsEl.querySelectorAll("[data-customer-id]").forEach((btn) => {
        btn.addEventListener("click", () => {
          overlay.remove();
          navigate(`#/orders/new/${btn.dataset.customerId}`);
        });
      });
    }

    let debounceTimer = null;
    searchEl.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => search(searchEl.value.trim()), 200);
    });
    search("");
  }

  load();
}
