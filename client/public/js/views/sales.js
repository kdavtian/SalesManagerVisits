// Read-only Sales viewer -- ERP order history (erp_order_lines) grouped
// into orders, company-wide, mirroring the existing per-customer "show all
// orders" screen (customerOrders.js) but scoped by date range/channel/
// customer search instead of a single customer. See server/src/routes/
// sales.js: no write-back, ERP/Excel stays the source of truth, same
// contract as Debt Balances.
import { api } from "../api.js";
import { escapeHtml, formatAmd, formatDateDMY, channelDisplayLabel, activateDialog, syncBadgeHtml } from "../util.js";
import { t } from "../i18n.js";

// Local calendar-date components, not toISOString() -- that converts to
// UTC first, so a local midnight east of UTC (Yerevan is UTC+4) lands on
// the *previous* day once sliced back to YYYY-MM-DD (reported as the
// default "from" date showing the last day of the previous month instead
// of the 1st). Same class of bug util.js's own date-only helpers already
// avoid for the same reason.
function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function groupLinesByBrand(lines) {
  const byBrand = new Map();
  for (const line of lines) {
    const brand = line.brand || t("erp_brand_unspecified");
    if (!byBrand.has(brand)) byBrand.set(brand, []);
    byBrand.get(brand).push(line);
  }
  return byBrand;
}

async function openSalesOrderSheet(erpCustomerId, orderId) {
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.innerHTML = `<div class="sheet"><p class="loading-state" role="status">${t("loading")}</p></div>`;
  document.body.appendChild(overlay);
  activateDialog(overlay);
  overlay.addEventListener("click", (e) => e.target === overlay && overlay.remove());

  let detail;
  try {
    detail = await api.getSalesOrder(erpCustomerId, orderId);
  } catch (err) {
    overlay.querySelector(".sheet").innerHTML = `<p class="form-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const byBrand = groupLinesByBrand(detail.lines);
  const brandSections = [...byBrand.entries()]
    .map(
      ([brand, lines]) => `
      <p class="proposed-changes-label">${escapeHtml(brand)}</p>
      ${lines
        .map(
          (l) => `
        <div class="erp-line-row">
          <span>${escapeHtml(l.product_name || "")}${l.size_l ? ` ${escapeHtml(String(l.size_l))}L` : ""}</span>
          <span class="muted">${escapeHtml(String(l.qty ?? ""))}pcs</span>
          <span>${formatAmd(l.unit_price_amd)}</span>
        </div>`
        )
        .join("")}`
    )
    .join("");

  overlay.querySelector(".sheet").innerHTML = `
    <div class="order-detail-header">
      <h2>${escapeHtml(detail.order_id)}</h2>
      <button class="icon-btn" id="close-order-detail" aria-label="${t("cancel")}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="order-detail-meta">
      <span>${escapeHtml(detail.customer_name || "")}</span>
      <span class="erp-debt-amount">${formatAmd(detail.total_amd)}</span>
    </div>
    <p class="muted" style="margin: -4px 0 10px;">${escapeHtml(String(detail.order_date).slice(0, 10))}${detail.channel ? ` · ${escapeHtml(channelDisplayLabel(detail.channel))}` : ""}</p>
    ${brandSections}
  `;
  overlay.querySelector("#close-order-detail").addEventListener("click", () => overlay.remove());
}

export async function renderSales(root, navigate) {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  let from = formatDateInput(monthStart);
  let to = formatDateInput(today);
  let channel = "";
  let q = "";
  let searchTimer = null;

  root.innerHTML = `
    <div class="detail-view">
      <div class="detail-header">
        <button class="icon-btn" id="back-btn" aria-label="${t("back")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>
        <div class="detail-header-title"><h1>${t("sales_title")}</h1></div>
      </div>
      <div id="sales-sync-badge"></div>
      <p class="muted sales-source-hint">${t("sales_source_hint")}</p>
      <div class="sales-filter-row">
        <label>${t("date_from")}<input type="date" id="sales-from" value="${from}" /></label>
        <label>${t("date_to")}<input type="date" id="sales-to" value="${to}" /></label>
      </div>
      <div class="customer-stats-bar sales-channel-bar" id="sales-channel-bar" aria-label="${escapeHtml(t("sales_channel_filter"))}"></div>
      <div class="list-toolbar">
        <label class="visually-hidden" for="sales-search">${t("sales_search_placeholder")}</label>
        <input type="search" id="sales-search" placeholder="${t("sales_search_placeholder")}" aria-label="${t("sales_search_placeholder")}" />
      </div>
      <p class="form-error" id="sales-error" hidden></p>
      <p class="sales-subtotal-bar" id="sales-subtotal"></p>
      <div id="sales-list" class="card-list"></div>
    </div>
  `;

  const container = root.querySelector(".detail-view");
  container.querySelector("#back-btn").addEventListener("click", () => navigate.goBack("#/dashboard"));
  const listEl = container.querySelector("#sales-list");
  const errorEl = container.querySelector("#sales-error");
  const subtotalEl = container.querySelector("#sales-subtotal");
  const syncBadgeEl = container.querySelector("#sales-sync-badge");
  const fromInput = container.querySelector("#sales-from");
  const toInput = container.querySelector("#sales-to");
  const channelBarEl = container.querySelector("#sales-channel-bar");
  const searchInput = container.querySelector("#sales-search");
  let channelPills = [{ value: "", label: t("all_statuses"), count: 0 }];

  // Same tappable-pill filter as Activity's "by sales manager" bar (see
  // views/activity.js's renderManagerPills) -- tapping the pill that's
  // already active clears the filter, so "All" isn't the only way back.
  function renderChannelBar() {
    channelBarEl.innerHTML = channelPills
      .map(
        (p) => `
      <button type="button" class="stat-pill ${channel === p.value ? "stat-pill-active" : ""}" data-channel="${escapeHtml(p.value)}" aria-pressed="${channel === p.value}">
        <strong>${p.count}</strong>
        <span>${escapeHtml(p.label)}</span>
      </button>`
      )
      .join("");
    channelBarEl.querySelectorAll(".stat-pill").forEach((btn) => {
      btn.addEventListener("click", () => {
        channel = channel === btn.dataset.channel ? "" : btn.dataset.channel;
        load();
      });
    });
  }

  function rowHtml(o) {
    return `
      <button type="button" class="card sales-order-card" data-erp-customer-id="${escapeHtml(o.erp_customer_id)}" data-order-id="${escapeHtml(o.order_id)}">
        <div class="sales-order-row">
          <span class="muted">${formatDateDMY(o.order_date)}${o.channel ? ` · ${escapeHtml(channelDisplayLabel(o.channel))}` : ""}</span>
          <span class="text-amount sales-order-amount">${formatAmd(Number(o.total_amd))}</span>
        </div>
        <strong>${escapeHtml(o.customer_name || "")}</strong>
        <div class="sales-order-row muted">
          <span>${escapeHtml(o.order_id)}</span>
        </div>
      </button>`;
  }

  function render(rows) {
    if (!rows.length) {
      subtotalEl.textContent = "";
      listEl.innerHTML = `<p class="empty-state">${t("sales_empty")}</p>`;
      return;
    }
    const subtotal = rows.reduce((sum, o) => sum + Number(o.total_amd || 0), 0);
    subtotalEl.textContent = `${t("sales_subtotal")}: ${formatAmd(subtotal)} (${rows.length} ${t("sales_order_count")})`;
    listEl.innerHTML = rows.map(rowHtml).join("");
    listEl.querySelectorAll(".sales-order-card").forEach((card) => {
      card.addEventListener("click", () => openSalesOrderSheet(card.dataset.erpCustomerId, card.dataset.orderId));
    });
  }

  async function load() {
    listEl.innerHTML = `<p class="loading-state" role="status">${t("loading")}</p>`;
    errorEl.hidden = true;
    try {
      const params = { from, to };
      if (channel) params.channel = channel;
      if (q) params.q = q;
      const { rows, sync } = await api.getSales(params);
      syncBadgeEl.innerHTML = syncBadgeHtml(sync);

      // Pill counts are only ever refreshed from an unfiltered-by-channel
      // fetch (this one, since `channel` is only added to params after a
      // pill is tapped) -- filtering by channel server-side would otherwise
      // collapse every other pill's count to 0. The bar itself is still
      // re-rendered every load() below so its active state always reflects
      // the current `channel`, even on a call that skips this recompute.
      if (!channel) {
        const counts = new Map();
        for (const r of rows) {
          if (!r.channel) continue;
          counts.set(r.channel, (counts.get(r.channel) || 0) + 1);
        }
        channelPills = [
          { value: "", label: t("all_statuses"), count: rows.length },
          ...[...counts.entries()]
            .map(([code, count]) => ({ value: code, label: channelDisplayLabel(code), count }))
            .sort((a, b) => b.count - a.count),
        ];
      }
      renderChannelBar();

      render(rows);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
      listEl.innerHTML = "";
      subtotalEl.textContent = "";
    }
  }

  fromInput.addEventListener("change", () => {
    from = fromInput.value || from;
    load();
  });
  toInput.addEventListener("change", () => {
    to = toInput.value || to;
    load();
  });
  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      q = searchInput.value.trim();
      load();
    }, 300);
  });

  load();
}
