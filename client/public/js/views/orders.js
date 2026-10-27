import { api } from "../api.js";
import { escapeHtml, formatAmd, activateDialog, channelDisplayLabel, formatLiters, monthShort, formatDateTime, showToast } from "../util.js";
import { t, getLang } from "../i18n.js";
import { icons } from "../icons.js";
import { ORDER_STATUS_ICONS } from "../ordersSearchEnhancements.js";
import { loadWithCache } from "../listCache.js";
import { STATUS_META, orderStatusMeta, openOrderDetailSheet, paymentMethodBadgeHtml, appBadgeHtml } from "../orderDetailSheet.js";
import { deskHeadHtml, wireDeskHead, paintDeskHead } from "../deskTable.js";
import { dockedKey } from "../dockSheet.js";
import { availableBulkActions, runBulkAction } from "../orderBulk.js";
import { openPrintBlankSheet } from "../orderBlankPrint.js";
import { ACCOUNTING_STATUS_BADGE, accountingStatusLabel } from "../accountingDocSheet.js";
import { state } from "../state.js";

// Who sees (and can filter by) the accounting-document status -- mirrors
// canConfirmOrders in the server's roles.js.
const ACCOUNTING_ROLES = new Set(["admin", "sales_director", "ceo", "operations_director", "accountant"]);
const ACCOUNTING_FILTERS = ["pending", "in_progress", "waybill_created", "partially_created", "exported_unsigned", "signed", "needs_attention", "cancelled"];
// The "Accounting" group next to Draft: every order that was sent to accounting
// (a waybill or invoice request), with its own row of request-status chips.

// Draft is last: it is not yet part of the live pipeline.
const STATUS_FILTERS = ["", "submitted", "confirmed", "packed_stock_out", "delivered", "draft"];

function formatDate(value) {
  return formatDateTime(value);
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
  const month = monthShort(d);
  return `${d.getDate()} ${month}`;
}

// How stale the open Orders list may get before it quietly refreshes itself (only while the screen is showing).
const AUTO_REFRESH_MS = 30000;

// Returns the view's cleanup (app.js keeps it): stops the timers, and `onRestore` refreshes the list when this screen is
// brought back from the Back cache -- its DOM and its rows are exactly what they were when the user left.
export function renderOrders(root, navigate, openId = null) {
  root.innerHTML = `
    <div class="detail-view">
      <div class="list-header-row">
        <h1>${t("orders_title")}</h1>
        <div class="orders-header-actions">
          <button type="button" class="icon-btn orders-new-action" id="orders-print-btn" aria-label="${t("print_blank_select")}" aria-pressed="false">${icons.printer}</button>
          <button type="button" class="icon-btn" id="orders-new-btn" aria-label="${t("create_order")}">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </div>
      </div>
      <div class="order-status-filter-row" id="order-status-filters"></div>
      <div class="list-toolbar">
        <input type="search" id="order-search" placeholder="${t("search")}" aria-label="${t("search")}" />
        <button type="button" class="icon-btn" id="order-filter-btn" aria-label="${t("filter")}" aria-haspopup="menu" aria-expanded="false" aria-controls="order-filter-menu">${icons.filter}</button>
        <div id="order-filter-menu" class="dropdown-menu" role="menu" hidden></div>
      </div>
      ${deskHeadHtml("desk-thead-orders", [
        { items: [{ label: t("desk_col_customer"), key: "customer" }, { label: t("desk_col_date"), key: "date" }] },
        { items: [{ label: t("desk_col_status"), key: "status" }] },
        { align: "end", items: [{ label: t("desk_col_amount"), key: "amount" }] },
      ])}
      <div class="card-list" id="orders-list"><p class="loading-state" role="status">${t("loading")}</p></div>
      <div class="orders-select-bar" id="orders-select-bar" hidden>
        <div class="osb-summary">
          <span id="orders-select-count"></span>
          <button type="button" class="rps-link osb-all" id="orders-select-all">${t("bulk_select_all")}</button>
        </div>
        <div class="osb-note" id="osb-note" hidden>
          <input type="text" id="osb-note-input" maxlength="300" placeholder="${t("reject_order_note_prompt")}" />
        </div>
        <div class="osb-actions" id="osb-actions"></div>
      </div>
    </div>
  `;

  // Submitted is the default view -- that's the queue someone opening this
  // page almost always cares about (what still needs confirming), not the
  // full history. Mirrors Payments' own "pending by default" convention,
  // and matches what the Orders nav badge itself counts, so tapping a
  // badge showing "3" lands on exactly those 3 instead of every order.
  const DEFAULT_STATUS_FILTER = "submitted";

  const filterRow = root.querySelector("#order-status-filters");
  filterRow.innerHTML = STATUS_FILTERS
    .map(
      (s) =>
        `<button class="map-filter-chip ${s === DEFAULT_STATUS_FILTER ? "chip-active" : ""}" data-status="${s}" aria-pressed="${s === DEFAULT_STATUS_FILTER ? "true" : "false"}">${
          s ? t(STATUS_META[s].key) : t("all_statuses")
        }</button>`
    )
    .join("");
  // Server query for the current tab (the Accounting group asks for orders
  // that have an accounting request instead of a fulfilment status).
  function listParams() {
    const params = activeStatus ? { status: activeStatus } : {};
    if (sortKey !== "date" || sortReversed) {
      params.sort = sortKey;
      if (sortReversed) params.reverse = "1";
    }
    return params;
  }

  const listEl = root.querySelector("#orders-list");
  const searchInput = root.querySelector("#order-search");
  const filterBtn = root.querySelector("#order-filter-btn");
  const filterMenu = root.querySelector("#order-filter-menu");

  // Select mode (long press an order, or the print button): tick orders, then run one action on all of them
  // (confirm, reject, mark delivered, approve a price change / credit) or print their blanks.
  // Desktop column headings (hidden on a phone): a click sorts the WHOLE history on the server (?sort=&reverse=), a
  // second click reverses. "date" is the default and keeps the per-day headings; any other sort is one flat list.
  const headEl = root.querySelector(".desk-thead-orders");
  let sortKey = "date";
  let sortReversed = false;
  wireDeskHead(headEl, (key) => {
    sortReversed = key === sortKey ? !sortReversed : false;
    sortKey = key;
    paintDeskHead(headEl, sortKey, sortReversed);
    load();
  });
  paintDeskHead(headEl, sortKey, sortReversed);
  let selectMode = false;
  const selected = new Map(); // id -> order_code
  const printBtn = root.querySelector("#orders-print-btn");
  const selectBar = root.querySelector("#orders-select-bar");
  const actionsEl = root.querySelector("#osb-actions");
  const noteEl = root.querySelector("#osb-note");
  let rejectPending = false; // the Reject button was pressed: ask for a reason first
  let bulkBusy = false;
  const selectedOrders = () => [...selected.keys()].map((id) => orders.find((o) => o.id === id)).filter(Boolean);
  function updateSelectBar() {
    selectBar.hidden = !selectMode;
    printBtn.setAttribute("aria-pressed", String(selectMode));
    printBtn.classList.toggle("is-active", selectMode);
    root.querySelector(".detail-view").classList.toggle("orders-select-mode", selectMode);
    const list = selectedOrders();
    const total = list.reduce((sum, o) => sum + Number(o.total_amd), 0);
    root.querySelector("#orders-select-count").textContent = selected.size ? t("bulk_selected").replace("{n}", String(selected.size)).replace("{amount}", formatAmd(total)) : t("bulk_pick_hint");
    noteEl.hidden = !rejectPending;
    const actions = availableBulkActions(list);
    actionsEl.innerHTML =
      `<button type="button" class="btn osb-secondary" id="orders-select-cancel">${t("cancel")}</button>` +
      actions
        .map((a) => `<button type="button" class="btn ${a.danger ? "btn-danger" : a.primary ? "btn-primary" : ""}" data-bulk="${a.key}" ${bulkBusy ? "disabled" : ""}>${t(a.labelKey)} (${a.orders.length})</button>`)
        .join("") +
      `<button type="button" class="btn osb-secondary" id="orders-select-print" ${selected.size === 0 ? "disabled" : ""}>${t("print_blank_create")}</button>`;
    actionsEl.querySelector("#orders-select-cancel").addEventListener("click", () => setSelectMode(false));
    actionsEl.querySelector("#orders-select-print").addEventListener("click", () => {
      openPrintBlankSheet([...selected].map(([id, order_code]) => ({ id, order_code })));
    });
    actionsEl.querySelectorAll("[data-bulk]").forEach((btn) =>
      btn.addEventListener("click", () => startBulk(actions.find((a) => a.key === btn.dataset.bulk)))
    );
  }
  function setSelectMode(on) {
    selectMode = on;
    rejectPending = false;
    if (!on) selected.clear();
    updateSelectBar();
    paint();
  }
  async function startBulk(action) {
    if (bulkBusy) return;
    if (action.needsNote && !rejectPending) {
      rejectPending = true; // second press (after the reason field shows) really rejects
      updateSelectBar();
      root.querySelector("#osb-note-input").focus();
      return;
    }
    const note = action.needsNote ? root.querySelector("#osb-note-input").value.trim() : "";
    bulkBusy = true;
    const label = t(action.labelKey);
    root.querySelector("#orders-select-count").textContent = `${label}…`;
    const { ok, failed } = await runBulkAction(action, action.orders, {
      note,
      onProgress: (done, total) => (root.querySelector("#orders-select-count").textContent = `${label} ${done}/${total}`),
    });
    bulkBusy = false;
    window.dispatchEvent(new Event("orders-changed"));
    if (action.key === "deliver") window.dispatchEvent(new Event("delivery-changed"));
    setSelectMode(false);
    await load();
    showToast(failed.length ? t("bulk_result_failed").replace("{ok}", String(ok)).replace("{fail}", String(failed.length)).replace("{why}", failed[0].message) : t("bulk_result_ok").replace("{n}", String(ok)), { ms: failed.length ? 6000 : 3000 });
  }
  printBtn.addEventListener("click", () => setSelectMode(!selectMode));
  root.querySelector("#orders-select-all").addEventListener("click", () => {
    for (const o of visibleOrders) selected.set(o.id, o.order_code ?? null);
    updateSelectBar();
    paint();
  });
  let visibleOrders = [];
  let suppressClickUntil = 0;

  let activeStatus = DEFAULT_STATUS_FILTER;
  let channelFilter = "";
  let accountingFilter = "";
  let orders = [];
  let hasMore = false;
  let loadingMore = false;
  let searchDebounceTimer;
  // Every load gets a number; a slower, older answer (tab switched meanwhile, two refreshes racing) is thrown away
  // instead of painting rows of the wrong tab over the right ones.
  let loadSeq = 0;
  let lastLoadedAt = 0;
  let lastOrdersSig = null;
  let pagesLoaded = 1;

  function renderFilterMenu() {
    const channels = [...new Set(orders.map((o) => o.sales_channel).filter(Boolean))].sort();
    filterMenu.innerHTML = `
      <button role="menuitemradio" aria-checked="${channelFilter === ""}" data-channel="">${t("all_channels")}</button>
      ${channels
        .map((c) => `<button role="menuitemradio" aria-checked="${c === channelFilter}" data-channel="${escapeHtml(c)}">${escapeHtml(channelDisplayLabel(c))}</button>`)
        .join("")}
      ${
        ACCOUNTING_ROLES.has(state.user.role)
          ? `<div class="dropdown-menu-heading muted" role="presentation">${t("acc_section_title")}</div>
      <button role="menuitemradio" aria-checked="${accountingFilter === ""}" data-accounting="">${t("acc_filter_any")}</button>
      <button role="menuitemradio" aria-checked="${accountingFilter === "none"}" data-accounting="none">${t("acc_filter_none")}</button>
      ${ACCOUNTING_FILTERS.map((f) => `<button role="menuitemradio" aria-checked="${accountingFilter === f}" data-accounting="${f}">${f === "waybill_created" ? t("acc_status_document_created") : t(`acc_status_${f}`)}</button>`).join("")}`
          : ""
      }
    `;
    filterMenu.querySelectorAll("[data-accounting]").forEach((btn) => {
      btn.addEventListener("click", () => {
        accountingFilter = btn.dataset.accounting;
        filterMenu.hidden = true;
        filterBtn.setAttribute("aria-expanded", "false");
        paint();
      });
    });
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

  async function load({ silent = false } = {}) {
    const mine = ++loadSeq;
    if (silent) {
      // Background refresh of an open screen: no spinner, no cached (older) rows first, and the list is left alone when
      // the user is in the middle of something.
      try {
        const result = await api.listOrders(listParams(), { fresh: true });
        if (mine !== loadSeq || selectMode || bulkBusy) return;
        lastLoadedAt = Date.now();
        const sig = JSON.stringify([result.rows, result.has_more]);
        if (sig === lastOrdersSig && pagesLoaded === 1) return; // nothing new: leave the list (and the reader's place in it) alone
        lastOrdersSig = sig;
        orders = result.rows;
        hasMore = result.has_more;
        pagesLoaded = 1;
        paint();
      } catch {
        /* the next refresh tries again; the rows on screen stay */
      }
      return;
    }
    // Stale-while-revalidate (see listCache.js): repaint from last
    // session's first page for this exact status tab immediately, then
    // swap in the live page once it lands -- pagination (loadMore below)
    // stays fully live, only the first page benefits from this.
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    pagesLoaded = 1;
    let paintedOnce = false;
    try {
      const params = listParams();
      await loadWithCache(
        `orders-list:${activeStatus || "all"}${sortKey !== "date" || sortReversed ? `:${sortKey}${sortReversed ? ":rev" : ""}` : ""}`,
        () => api.listOrders(params, { fresh: true }),
        (result) => {
          if (mine !== loadSeq) return;
          lastLoadedAt = Date.now();
          // Same rows as already on screen (the saved copy, then the fresh answer; or a quiet refresh that found nothing new): no repaint.
          const sig = JSON.stringify([result.rows, result.has_more]);
          if (paintedOnce && sig === lastOrdersSig) return;
          lastOrdersSig = sig;
          orders = result.rows;
          hasMore = result.has_more;
          paint();
          paintedOnce = true;
        }
      );
    } catch (err) {
      if (!paintedOnce && mine === loadSeq) listEl.innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    }
  }

  // The open screen keeps itself current: when the app comes back to the front, on a slow timer, after a change made
  // elsewhere, and when the screen is restored by Back. Counts on the nav badge refresh together with the list.
  function refreshIfStale(maxAgeMs) {
    if (!listEl.isConnected || document.visibilityState === "hidden") return;
    if (selectMode || bulkBusy || loadingMore || pagesLoaded > 1) return;
    if (Date.now() - lastLoadedAt < maxAgeMs) return;
    load({ silent: true });
    window.dispatchEvent(new Event("badges-refresh"));
  }
  const onVisible = () => {
    if (document.visibilityState === "visible") refreshIfStale(8000);
  };
  const onOrdersChanged = () => refreshIfStale(0);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("orders-changed", onOrdersChanged);
  // The wide-window detail panel opened/closed/swapped: mark its row in the list (no repaint needed).
  const onDockedChange = () => {
    const key = dockedKey();
    listEl.querySelectorAll("[data-order-id]").forEach((row) => {
      const open = key === `order:${row.dataset.orderId}`;
      if (row.classList.contains("row-open") !== open) row.classList.toggle("row-open", open);
    });
  };
  window.addEventListener("docked-change", onDockedChange);
  const autoRefreshTimer = setInterval(() => refreshIfStale(AUTO_REFRESH_MS), 15000);

  async function loadMore() {
    if (loadingMore || !hasMore) return;
    loadingMore = true;
    const mine = loadSeq;
    const btn = listEl.querySelector("#orders-load-more");
    if (btn) btn.disabled = true;
    try {
      const params = listParams();
      params.offset = orders.length;
      const result = await api.listOrders(params, { fresh: true });
      // The tab (or a refresh) changed while this page was on its way: these rows belong to an older list.
      if (mine === loadSeq) {
        orders = orders.concat(result.rows);
        hasMore = result.has_more;
        pagesLoaded += 1;
      }
    } finally {
      loadingMore = false;
    }
    paint();
  }

  function paint() {
    const search = searchInput.value.trim().toLowerCase();
    let filtered = orders;
    if (channelFilter) filtered = filtered.filter((o) => o.sales_channel === channelFilter);
    if (accountingFilter) filtered = filtered.filter((o) => (accountingFilter === "none" ? !o.accounting_status : o.accounting_status === accountingFilter));
    if (search) {
      filtered = filtered.filter((o) => {
        const haystack = [o.customer_name, o.order_code, o.user_name, o.sales_channel, formatDate(o.created_at)]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(search);
      });
    }

    visibleOrders = filtered;
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
        const meta = orderStatusMeta(o);
        const dateKey = orderDateKey(o.created_at);
        let dateHeading = "";
        if (sortKey === "date" && dateKey !== lastDateKey) {
          lastDateKey = dateKey;
          const day = dayTotals.get(dateKey);
          dateHeading = `
            <div class="order-date-heading">
              <span class="order-date-heading-label">${formatOrderDateHeading(o.created_at)}</span>
              <span class="order-date-heading-stats">${formatAmd(day.total)} | ${formatLiters(day.liters)} | ${day.count} ${t("orders_count_label")}</span>
            </div>`;
        }
        return `${dateHeading}
        <button class="card list-row${selectMode && selected.has(o.id) ? " order-row-selected" : ""}${dockedKey() === `order:${o.id}` ? " row-open" : ""}" data-order-id="${o.id}">
          ${
            selectMode
              ? `<span class="list-row-icon order-select-slot" aria-hidden="true"><span class="order-select-check${selected.has(o.id) ? " is-on" : ""}"></span></span>`
              : `<span class="list-row-icon order-tile order-tile-${o.status}" aria-hidden="true">${ORDER_STATUS_ICONS[o.status] ?? ""}</span>`
          }
          <div class="list-row-body">
            <div class="list-row-top">
              <strong>${escapeHtml(o.customer_name)}</strong>
              <span class="list-row-trailing-text text-amount">${formatAmd(Number(o.total_amd))}</span>
            </div>
            <div class="muted list-row-meta">${o.order_code ? `${escapeHtml(o.order_code)} · ` : ""}${escapeHtml(o.user_name)} · ${formatDate(o.created_at)}${o.checkin_id ? ` · ${t("order_at_visit")}` : ""}</div>
            <div class="list-row-bottom">
              ${appBadgeHtml(o)}
              <span class="badge ${meta.cls}">${t(meta.key)}</span>
              ${o.delivered_from_erp ? `<span class="badge badge-info">${t("from_erp")}</span>` : ""}
              ${paymentMethodBadgeHtml(o.payment_method)}
              ${o.accounting_status ? `<span class="badge ${ACCOUNTING_STATUS_BADGE[o.accounting_status] ?? "badge-neutral"}">${accountingStatusLabel(o.accounting_status, o.accounting_doc_type)}</span>` : ""}
              ${o.document_count > 0 ? `<span class="badge badge-neutral">&#128206; ${o.document_count}</span>` : ""}
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
    if (hasMore && !search && !channelFilter && !accountingFilter) {
      listEl.insertAdjacentHTML("beforeend", `<button type="button" class="btn btn-block" id="orders-load-more">${t("load_more")}</button>`);
      listEl.querySelector("#orders-load-more").addEventListener("click", loadMore);
    }

    listEl.querySelectorAll("[data-order-id]").forEach((row) => {
      const id = Number(row.dataset.orderId);
      const toggle = () => {
        if (selected.has(id)) selected.delete(id);
        else selected.set(id, orders.find((o) => o.id === id)?.order_code ?? null);
        row.classList.toggle("order-row-selected", selected.has(id));
        row.querySelector(".order-select-check")?.classList.toggle("is-on", selected.has(id));
        updateSelectBar();
      };
      let timer = null;
      let startX = 0;
      let startY = 0;
      const cancelHold = () => {
        clearTimeout(timer);
        timer = null;
      };
      // Long press: enters select mode with this order selected (the status icons turn into check boxes).
      row.addEventListener("pointerdown", (e) => {
        startX = e.clientX;
        startY = e.clientY;
        cancelHold();
        timer = setTimeout(() => {
          suppressClickUntil = Date.now() + 800; // paint() replaces the row, so the release lands on the new one
          navigator.vibrate?.(15);
          if (!selectMode) {
            selectMode = true;
            selected.set(id, orders.find((o) => o.id === id)?.order_code ?? null);
            updateSelectBar();
            paint();
          } else toggle();
        }, 500);
      });
      row.addEventListener("pointermove", (e) => {
        if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancelHold();
      });
      for (const type of ["pointerup", "pointercancel", "pointerleave"]) row.addEventListener(type, cancelHold);
      row.addEventListener("contextmenu", (e) => e.preventDefault());
      row.addEventListener("click", () => {
        if (Date.now() < suppressClickUntil) return;
        if (!selectMode) return openOrderDetailSheet(id, { onChanged: load, navigate });
        toggle();
      });
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
        results = await api.listCustomers(query ? { search: query, limit: 30 } : { limit: 30 });
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
  // A notification (or any link) for ONE order: #/orders?open=<id> opens that order's sheet on top of the list.
  if (openId && /^\d+$/.test(String(openId))) openOrderDetailSheet(Number(openId), { onChanged: load, navigate });

  const cleanup = () => {
    clearInterval(autoRefreshTimer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("orders-changed", onOrdersChanged);
    window.removeEventListener("docked-change", onDockedChange);
  };
  cleanup.onRestore = () => refreshIfStale(0);
  return cleanup;
}
